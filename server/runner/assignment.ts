import type { AgentLoopOptions, AgentLoopResult, RunEvent, RunEventInput } from '@cubicecho/agent-core';
import type { ResolvedAgent } from '@cubicecho/agent-core/spec';

/** A tool the router calls for the run: one of a server's tools, through the run's workspace instance. */
export const TOOL_ORIGIN_ROUTER = 'router' as const;
/** A tool the worker calls itself, where the loop runs. */
export const TOOL_ORIGIN_LOCAL = 'local' as const;
/** Who answers a call to one of the run's tools. */
export type ToolOrigin = typeof TOOL_ORIGIN_ROUTER | typeof TOOL_ORIGIN_LOCAL;

/** One tool definition, as the loop sends it to the model. */
export type ToolDefinition = NonNullable<AgentLoopOptions['tools']>[number];
/** One of the app's own tools, which the run hands back. */
export type AppToolDefinition = Extract<NonNullable<AgentLoopOptions['hostTools']>[number], { type: 'function' }>;
/** The servers and tools the model is told of when it discovers tools as it goes. */
export type ToolCatalog = NonNullable<AgentLoopOptions['catalog']>;
/** One message of a run's transcript. */
export type TranscriptMessage = AgentLoopOptions['messages'][number];
/** What the model spent, as the loop counts it. */
export type LoopUsage = AgentLoopResult['usage'];

/** What answers a call to one of the run's tools, by the name the model calls it. */
export interface ToolTarget {
  origin: ToolOrigin;
  /** The server's id, for a router tool. */
  server: string;
  /** The tool's own name on its server. */
  tool: string;
}

/**
 * One stretch of a run, as a worker is handed it: from its start or a resume, to its answer or its next wait.
 *
 * @remarks
 * JSON only, so a worker in another process can be sent it. The model calls go through `RunPorts.modelFetch`, so the
 * config carries no `fetch`.
 */
export interface RunAssignment {
  runId: string;
  /** The agent as the run's layers resolved it, its endpoints the router's models address unless it has its own. */
  config: ResolvedAgent;
  /** The system prompt's parts, the agent's with the app's stacked on. */
  prompt: AgentLoopOptions['systemPrompt'];
  /** The transcript the loop carries on from. */
  messages: TranscriptMessage[];
  /** The tools already loaded into the model's list, for one that discovers them as it goes. */
  loaded: string[];
  /** The tools the run reaches, as the model is told of them. */
  tools: ToolDefinition[];
  /** The same tools by server, for one that discovers them as it goes. */
  catalog: ToolCatalog;
  /** What answers each of the run's tools, by function name. */
  targets: Record<string, ToolTarget>;
  /** The app's tools this stretch hands back. */
  appTools: AppToolDefinition[];
}

/** How a call to a tool is made, besides its arguments. */
export interface ToolCallOptions {
  /** The model's call, as the loop numbered it: what the router files the call's events under. */
  call: { id: string; name: string };
  /** Aborted when the call's answer is no longer wanted. */
  signal: AbortSignal;
}

/** What the router lends a worker for one stretch of a run. */
export interface RunPorts {
  /** Answers the run's model calls: every endpoint at the router's models address goes through it. */
  modelFetch: typeof globalThis.fetch;
  /**
   * Calls one of a server's tools, as the run's workspace configures it. The router asks the server's questions and
   * files its progress itself.
   *
   * @param server - The server's id.
   * @param tool - The tool's own name.
   * @param args - What the model called it with.
   * @param options - The call, and its signal.
   * @returns What the tool said, as the model reads it.
   * @throws When the tool reports a failure: the model is told it.
   */
  callRouterTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    options: ToolCallOptions,
  ): Promise<string>;
  /**
   * Calls one of the worker's own tools. Absent where the worker has none.
   *
   * @param tool - The tool's name.
   * @param args - What the model called it with.
   * @param options - The call, and its signal.
   * @returns What the tool said, as the model reads it.
   */
  callLocalTool?(tool: string, args: Record<string, unknown>, options: ToolCallOptions): Promise<string>;
  /**
   * Tells the router one of the loop's events.
   *
   * @param event - The event, under the loop's call ids.
   * @returns The event as the run's bus numbered it.
   */
  publish(event: RunEventInput): RunEvent;
  /** Aborted when the run must stop: its cancel, its deadline, the app leaving, or the router stopping. */
  signal: AbortSignal;
}

/** A stretch the loop finished: with an answer, or with calls handed back to the app. */
export interface AnsweredOutcome {
  ok: true;
  /** The transcript, under the loop's call ids. */
  messages: TranscriptMessage[];
  usage: LoopUsage;
  loaded: string[];
  /** Why the last turn ended, as the model said it. */
  finishReason: AgentLoopResult['turn']['finishReason'];
  /** The loop ids of the app tool calls handed back, in the order they were made. Empty for an answer. */
  handedBack: string[];
}

/** A stretch the loop failed, or was stopped. */
export interface FailedOutcome {
  ok: false;
  /** What went wrong. */
  error: string;
  /** What the model spent before it failed, when the loop knows. */
  usage: LoopUsage | undefined;
}

/** How a stretch's loop ended. */
export type RunOutcome = AnsweredOutcome | FailedOutcome;
