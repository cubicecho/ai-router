import type { Snapshot, SnapshotAgent, SnapshotWorkspace } from '../db/snapshot.ts';
import type { Forwarder } from '../models/forward.ts';
import { type Conversation, withHistory } from './conversation.ts';
import { agentLayer, resolveRun, withRouterFetch } from './layers.ts';
import type { RunRequest } from './request.ts';
import type { Idempotency, RepeatedRun, RunService, StartedRun } from './run.ts';

/** An agent a workspace may run: one with a live revision, whose document the snapshot holds. */
export type RunnableAgent = SnapshotAgent & {
  document: Readonly<Record<string, unknown>>;
  /** The workspace's servers it has on there, by name: its runs there reach exactly these. */
  servers: readonly string[];
};

/** A new run, as a door to the agents asks for it. */
export interface NewRun {
  workspace: SnapshotWorkspace;
  agent: RunnableAgent;
  /** The checked request, without the conversation's history. */
  request: RunRequest;
  /** The conversation it carries on, or null for a stateless run. */
  conversation: Conversation | null;
  /** The session it belongs to, or null. */
  sessionKey: string | null;
  idempotency: Idempotency | null;
  /** How many agents deep it is: `APP_RUN_DEPTH`, or the depth an agent's call to `/mcp` names. */
  depth: number;
}

/** The depth of a run an app started on `/v1`: no agent called it. */
export const APP_RUN_DEPTH = 0;

/**
 * Finds the agent a workspace may run by its name.
 *
 * @param agents - The snapshot's agents.
 * @param workspaceId - The key's workspace.
 * @param name - The name the request gives.
 * @returns The agent, or null when it doesn't exist, has no live revision, or isn't the workspace's to run.
 */
export function runnableAgent(
  agents: ReadonlyMap<string, SnapshotAgent>,
  workspaceId: string,
  name: string | null,
): RunnableAgent | null {
  const agent = name === null ? undefined : agents.get(name);
  const servers = agent?.workspaces.get(workspaceId);
  if (agent === undefined || servers === undefined) {
    return null;
  }
  const { document } = agent;
  return agent.liveRevisionId === null || document === null ? null : { ...agent, document, servers };
}

/**
 * Lists the agents a workspace may run.
 *
 * @param snapshot - What the router routes by.
 * @param workspaceId - The key's workspace.
 * @returns The agents, in the snapshot's order.
 */
export function runnableAgents(snapshot: Snapshot, workspaceId: string): RunnableAgent[] {
  return [...snapshot.agents.values()].flatMap(
    (agent) => runnableAgent(snapshot.agents, workspaceId, agent.name) ?? [],
  );
}

/**
 * Starts a new run: the conversation's history, then the layers resolved over the agent, with the run's model calls
 * attributed to its workspace and agent.
 *
 * @param runs - The run service.
 * @param forwarder - The models area, which the run's model calls go through in process.
 * @param snapshot - What the router routes by, read once for the whole request.
 * @param run - The run.
 * @returns The run, to execute, or the one its `Idempotency-Key` already started.
 * @throws {@link UnreadableAgentError} When the agent's live document can't be parsed.
 */
export function beginRun(
  runs: RunService,
  forwarder: Forwarder,
  snapshot: Snapshot,
  { workspace, agent, request, conversation, sessionKey, idempotency, depth }: NewRun,
): Promise<StartedRun | RepeatedRun> {
  const withConversation = conversation === null ? request : withHistory(request, conversation);
  const { agent: resolved, prompt } = resolveRun(
    agentLayer(agent.name, agent.document),
    agent.servers,
    withConversation,
    snapshot,
  );
  const fetch = forwarder.fetchFor({
    workspaceId: workspace.id,
    workspaceName: workspace.slug,
    agentId: agent.id,
    agentName: agent.name,
  });
  const config = withRouterFetch(resolved, fetch);
  const input = {
    workspace,
    agent,
    request: withConversation,
    config,
    prompt,
    idempotency,
    conversation,
    sessionKey,
    depth,
  };
  return runs.begin(input);
}
