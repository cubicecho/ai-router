import {
  AGENT_SPEC,
  type AgentSpec,
  type ModelSpec,
  parseSpec,
  type ResolvedAgent,
  resolveAgentSpec,
} from '@cubicecho/agent-core/spec';
import type { Snapshot } from '../db/snapshot.ts';
import { MODELS_BASE_URL } from '../models/forward.ts';
import { narrowedServers } from './reach.ts';
import type { RunRequest } from './request.ts';

/** The prompt part an app's leading system messages become. A reserved id: no agent may use it. */
export const HOST_PART_ID = 'host';
/** The prompt part `ai_router.task` becomes. A reserved id: no agent may use it. */
export const TASK_PART_ID = 'task';

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

/**
 * Builds the request layer: the sampling settings for the main model, and a narrowing of the servers.
 *
 * @param request - The checked request.
 * @param agentServers - The agent's own `tools.servers`, resolved.
 * @param snapshot - The router's servers, for an agent that reaches every one.
 * @returns The layer, or null when the request sets nothing.
 *
 * @remarks
 * `temperature` and the ceiling go to the fields the format names for them, and only the rest to `extraBody`, so a
 * request's temperature can't hide in `extraBody` and beat the real one (agent-core#222). A side task never reads
 * `model`, so none of this reaches one.
 */
function requestLayer(
  request: RunRequest,
  agentServers: readonly string[] | undefined,
  snapshot: Snapshot,
): AgentSpec | null {
  const { temperature, maxTokens, extraBody } = request.sampling;
  const model: ModelSpec = {
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(Object.keys(extraBody).length === 0 ? {} : { extraBody }),
  };
  const setsModel = Object.keys(model).length > 0;
  const servers = request.servers === null ? null : narrowedServers(agentServers, request.servers, snapshot);
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
 * Stacks a run's layers and resolves them: the router, the agent, the host, the task, then the request.
 *
 * @param agent - The agent's own layer.
 * @param request - The checked request. The policy has already passed it.
 * @param snapshot - The router's servers.
 * @returns The resolved agent.
 *
 * @remarks
 * The host and task parts come after the agent's own, under ids no agent may use, so an app can never replace or
 * delete one of the agent's parts. Nothing above the agent names an endpoint or a model.
 */
export function resolveRun(agent: AgentSpec, request: RunRequest, snapshot: Snapshot): ResolvedAgent {
  const agentServers = resolveAgentSpec([ROUTER_LAYER, agent]).servers;
  const host: AgentSpec[] =
    request.hostText === null ? [] : [{ spec: AGENT_SPEC, prompt: [{ id: HOST_PART_ID, text: request.hostText }] }];
  const task: AgentSpec[] =
    request.taskText === null ? [] : [{ spec: AGENT_SPEC, prompt: [{ id: TASK_PART_ID, text: request.taskText }] }];
  const fromRequest = requestLayer(request, agentServers, snapshot);
  return resolveAgentSpec([ROUTER_LAYER, agent, ...host, ...task, ...(fromRequest === null ? [] : [fromRequest])]);
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
