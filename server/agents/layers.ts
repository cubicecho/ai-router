import {
  AGENT_SPEC,
  type AgentSpec,
  type ModelSpec,
  type PromptMode,
  parseSpec,
  type ResolvedAgent,
  resolveAgentSpec,
  type StackedPrompt,
  stackAppParts,
} from '@cubicecho/agent-core/spec';
import type { Snapshot } from '../db/snapshot.ts';
import { MODELS_BASE_URL } from '../models/forward.ts';
import { narrowedServers } from './reach.ts';
import type { RunRequest } from './request.ts';

/**
 * The router layer, underneath every agent: the router's own models, which the run's `fetch` answers in process.
 * An agent with an endpoint of its own replaces it, and then calls that address directly with no key.
 */
export const ROUTER_LAYER: AgentSpec = Object.freeze({
  spec: AGENT_SPEC,
  endpoint: Object.freeze({ baseUrl: MODELS_BASE_URL }),
});

/** A resolved agent whose router-bound endpoints, its own and its side tasks', carry the run's `fetch`. */
export type RunConfig = ResolvedAgent;

/** A run's layers resolved: the agent as the request may change it, and its prompt with the app's parts. */
export interface ResolvedRun {
  agent: ResolvedAgent;
  /** The agent's parts, then the app's and `app_system`, and the app's parts `stackAppParts` dropped. */
  prompt: StackedPrompt;
}

/** An agent's live document could not be read. The router's fault, not the app's. */
export class UnreadableAgentError extends Error {
  /**
   * Builds the error.
   *
   * @param agentName - The agent.
   * @param errors - What `parseSpec` said.
   */
  constructor(agentName: string, errors: readonly string[]) {
    super(`Agent "${agentName}" has a live document that no longer reads: ${errors.join('; ')}`);
    this.name = 'UnreadableAgentError';
  }
}

/**
 * Reads an agent's stored document as a layer.
 *
 * @param agentName - The agent, for the error.
 * @param document - Its live revision's document, as stored.
 * @returns The layer.
 * @throws {@link UnreadableAgentError} When the document no longer parses.
 */
export function agentLayer(agentName: string, document: Readonly<Record<string, unknown>>): AgentSpec {
  const parsed = parseSpec(document, { understands: [] });
  if (parsed.spec === null) {
    throw new UnreadableAgentError(agentName, parsed.errors);
  }
  return parsed.spec;
}

/** One of an agent's prompt parts as its model-list entry shows it: its name, and what an app may do to it. */
export interface PartRules {
  name: string;
  /** As the agent's document states it. Absent lets an app extend the part, and `[]` locks it. */
  allowedModes?: readonly PromptMode[];
}

/**
 * Reads what an app may do to each of an agent's prompt parts, without their text.
 *
 * @param agentName - The agent, for the error.
 * @param document - Its live revision's document, as stored.
 * @returns Its parts, in order, as resolved over the router layer.
 * @throws {@link UnreadableAgentError} When the document no longer parses.
 */
export function agentPartRules(agentName: string, document: Readonly<Record<string, unknown>>): PartRules[] {
  const { prompt } = resolveAgentSpec([ROUTER_LAYER, agentLayer(agentName, document)]);
  return prompt.map(({ name, allowedModes }) => (allowedModes === undefined ? { name } : { name, allowedModes }));
}

/**
 * Builds the request layer: the sampling settings for the main model, and a narrowing of the servers.
 *
 * @param request - The checked request.
 * @param granted - The servers the run reaches before the request: those its workspace granted the agent.
 * @param snapshot - The router's servers.
 * @returns The layer, or null when the request sets nothing.
 *
 * @remarks
 * `temperature` and the ceiling go to the fields the format names for them, and only the rest to `extraBody`, so a
 * request's temperature can't hide in `extraBody` and beat the real one (agent-core#222). A side task never reads
 * `model`, so none of this reaches one.
 */
function requestLayer(request: RunRequest, granted: readonly string[], snapshot: Snapshot): AgentSpec | null {
  const { temperature, maxTokens, extraBody } = request.sampling;
  const model: ModelSpec = {
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(Object.keys(extraBody).length === 0 ? {} : { extraBody }),
  };
  const setsModel = Object.keys(model).length > 0;
  const servers = request.servers === null ? null : narrowedServers(granted, request.servers, snapshot);
  if (setsModel === false && servers === null) {
    return null;
  }
  return {
    spec: AGENT_SPEC,
    ...(setsModel ? { model } : {}),
    ...(servers === null ? {} : { tools: { servers } }),
  };
}

/**
 * Puts the servers a workspace granted an agent in place of the ones its document names. ai-router doesn't read an
 * agent's own `tools.servers`: which servers an agent uses is the workspace's to decide, and none without a grant.
 *
 * @param agent - The agent's own layer.
 * @param granted - The servers its workspace granted it, by name.
 * @returns The layer, reaching exactly those servers.
 */
function withGrantedServers(agent: AgentSpec, granted: readonly string[]): AgentSpec {
  return { ...agent, tools: { ...agent.tools, servers: [...granted] } };
}

/**
 * Resolves a run's layers, the router's, the agent's and the request's, and stacks the app's parts on the agent's.
 *
 * @param agent - The agent's own layer.
 * @param granted - The servers the run's workspace granted the agent, by name. They replace the document's own.
 * @param request - The checked request. The policy has already passed it.
 * @param snapshot - The router's servers.
 * @returns The resolved agent, and its prompt with the app's parts.
 *
 * @remarks
 * The request can narrow the granted servers and never add one.
 * The request layer holds no prompt: the app's parts and system messages are stacked by agent-core's
 * `stackAppParts`, which prefixes every name with `app_`, so an app never overwrites or deletes an agent's part, and
 * extends or replaces one only where the part allows it. Nothing above the agent names an endpoint or a model.
 */
export function resolveRun(
  agent: AgentSpec,
  granted: readonly string[],
  request: RunRequest,
  snapshot: Snapshot,
): ResolvedRun {
  const ownLayer = withGrantedServers(agent, granted);
  const fromRequest = requestLayer(request, granted, snapshot);
  const resolved = resolveAgentSpec([ROUTER_LAYER, ownLayer, ...(fromRequest === null ? [] : [fromRequest])]);
  const prompt = stackAppParts(resolved.prompt, request.appParts ?? [], request.systemText ?? '');
  return { agent: resolved, prompt };
}

/**
 * Gives every endpoint of a resolved agent that points at the router's models the run's `fetch`.
 *
 * @param resolved - The resolved agent.
 * @param fetch - The run's `fetch`, from `Forwarder.fetchFor`.
 * @returns The config the loop runs with. An endpoint of the agent's own is left as it is, and called directly.
 */
export function withRouterFetch(resolved: ResolvedAgent, fetch: typeof globalThis.fetch): RunConfig {
  const isRouter = (baseUrl: string): boolean => baseUrl === MODELS_BASE_URL;
  const tasks = Object.fromEntries(
    Object.entries(resolved.tasks).map(([name, task]) => [
      name,
      isRouter(task.endpoint.baseUrl) ? { ...task, endpoint: { ...task.endpoint, fetch } } : task,
    ]),
  );
  return { ...resolved, ...(isRouter(resolved.baseUrl) ? { fetch } : {}), tasks };
}
