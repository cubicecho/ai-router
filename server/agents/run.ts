import {
  type CatalogServer,
  callIdsIn,
  createRuntime,
  ELICIT_TOOL,
  failedRun,
  freshCallId,
  nestEvent,
  preview,
  type RunEvent,
  type RunEventInput,
  RunEventKind,
  type Runtime,
  type StackedPrompt,
  type StackWarning,
} from '@cubicecho/agent-core';
import type { ResolvedAgent } from '@cubicecho/agent-core/spec';
import type { CallToolResult, ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { and, arrayOverlaps, eq, isNotNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { RUN_DEFAULTS, type RunSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import { nameSchema } from '../core/names.ts';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../core/wire.ts';
import type { DB } from '../db/client.ts';
import { violatedUniqueIndex } from '../db/errors.ts';
import type { SnapshotAgent, SnapshotHost, SnapshotWorkspace } from '../db/snapshot.ts';
import { agentRevisions } from '../db/tables/agent-revisions.ts';
import {
  type HandedBackCall,
  type RunAnswer,
  type RunResume,
  type RunRow,
  RunStatus,
  runs,
} from '../db/tables/runs.ts';
import { ModelFailure } from '../models/openai-error.ts';
import {
  type LoopUsage,
  type RunAssignment,
  type RunPorts,
  TOOL_ORIGIN_LOCAL,
  TOOL_ORIGIN_ROUTER,
  type ToolDefinition,
  type ToolOrigin,
} from '../runner/assignment.ts';
import type { ToolElicit, ToolServices } from '../tools/api.ts';
import { isToolError, toolResultContent, toolResultText } from '../tools/tool-result.ts';
import { createLocalWorker } from '../workers/local.ts';
import { createWorkerRegistry } from '../workers/registry.ts';
import { createRemoteWorkers, type RemoteWorkers } from '../workers/remote.ts';
import type { RunWorker } from '../workers/worker.ts';
import { type PrunedAppTool, pruneAppTools } from './app-tools.ts';
import {
  busyRun,
  type Conversation,
  openConversation,
  pruneConversations,
  saveConversation,
  touchConversation,
} from './conversation.ts';
import { answeredFields, answerOf, DECLINED } from './elicit.ts';
import { reachOf } from './reach.ts';
import { type AppTool, type ChatMessage, RequestRefusal, type RunRequest, type ToolAnswer } from './request.ts';
import { createRunBus, type RunBus } from './run-bus.ts';
import { type RunTool, runToolNames } from './tool-names.ts';

/** What joins the text of two turns in a run's answer. */
const TURN_JOIN = '\n\n';
/** OpenAI's finish reason for an answer cut off at its ceiling. */
const FINISH_LENGTH = 'length';
/** OpenAI's finish reason for an answer the model ended. */
const FINISH_STOP = 'stop';
/** OpenAI's finish reason for an answer that hands tool calls to the app. */
const FINISH_TOOL_CALLS = 'tool_calls';
/** What a run that a restart cut short says. */
const RESTARTED = 'The router restarted while the run was going.';
/** The unique index that keeps a conversation to one run at a time. */
const ONE_RUN_PER_CONVERSATION = 'uq_runs_conversation_id_going';
/** The statuses of a run that is not over. */
const GOING: RunStatus[] = [RunStatus.Running, RunStatus.Waiting];
/**
 * How many times a cancel looks at a run again: a waiting run a request resumes meanwhile is running when it looks
 * again, and a run stopping at an app tool is waiting.
 */
const CANCEL_ATTEMPTS = 3;
/** Where a run's record is read, on the router that ran it: what a called agent's run links to. */
const RUN_RECORD_PATH = '/runs/';
/** A run's id, as a called agent's answer names it. */
const runIdSchema = z.uuid();
/** The rule a worker's local server name must pass to reach a run, the same as the router's own servers'. */
const localServerName = nameSchema('A local server name');

/** A request's `Idempotency-Key`, and the hash of the body it came with. */
export interface Idempotency {
  key: string;
  hash: string;
}

/** What a run starts or resumes from: who asked, which agent, and the checked, resolved request. */
export interface RunInput {
  workspace: SnapshotWorkspace;
  /** An agent with a live revision, which this workspace may run. */
  agent: SnapshotAgent;
  request: RunRequest;
  /** The agent as the run's layers resolved it. */
  config: ResolvedAgent;
  /** The system prompt's parts, the agent's with the app's stacked on, and the app's parts that were dropped. */
  prompt: StackedPrompt;
  /** Answers the run's model calls at the router's models address: `Forwarder.fetchFor` its workspace and agent. */
  modelFetch: typeof globalThis.fetch;
  idempotency: Idempotency | null;
  /** The conversation the request names, whose history is already in `request`. Null for a stateless request. */
  conversation: Conversation | null;
  /** The session the request says it belongs to (`readSessionKey`). Recorded on a new run; a resume keeps the run's. */
  sessionKey: string | null;
  /** How many agents deep the run is: 0 for one an app started, one more for each agent call through `/mcp`. */
  depth: number;
}

/** A waiting run that a request's tool messages answer. */
export interface WaitingRun {
  runId: string;
  /** The conversation it belongs to. */
  conversationId: string | null;
  /** What it needs to carry on. */
  resume: RunResume;
  /** The document of the revision it started with, which it keeps. */
  document: Record<string, unknown>;
  /** The remote worker it ran on, which it carries on on. Null for `local`. */
  workerId: string | null;
}

/** A request the run service refuses because of where a run is, in OpenAI's words. */
export class RunConflict extends Error {
  /** How the agents endpoint answers it. */
  readonly failure: ModelFailure;

  /**
   * Builds the refusal.
   *
   * @param failure - How the agents endpoint answers it.
   * @param message - What the app is told.
   */
  constructor(failure: ModelFailure, message: string) {
    super(message);
    this.name = 'RunConflict';
    this.failure = failure;
  }
}

/** A run as it ended or as it waits, or as it stands for one still going elsewhere. */
export interface FinishedRun {
  runId: string;
  agentName: string;
  status: RunStatus;
  startedAt: Date;
  /** Null unless it completed or waits. */
  answer: RunAnswer | null;
  inputTokens: number;
  outputTokens: number;
  /** Why it failed, was cancelled or expired. */
  error: string | null;
}

/** Who hears a run as it goes: the request that is waiting on it. */
export interface RunListener {
  /**
   * Hears the answer's text as it arrives, a blank line between turns.
   *
   * @param text - What arrived.
   */
  onText(text: string): void;
  /**
   * Hears each event, as recorded, for the progress events an app asked for.
   *
   * @param event - The event.
   */
  onEvent(event: RunEvent): void;
  /**
   * Answers a server's question, for a caller that can. Absent, an app that follows the run's progress is asked by
   * ending its response with the reserved `agent_core_elicit` call, and any other client's run declines.
   */
  onElicit?: ToolElicit;
}

/** A run this request started or resumed. */
export interface StartedRun {
  kind: 'started';
  runId: string;
  startedAt: Date;
  /** The app tools left out because one of the agent's own tools answers them, by name, in the order sent. */
  prunedTools: string[];
  /** The app's prompt parts left out, because the agent's parts don't allow them: the answer's `agent_core.warnings`. */
  warnings: StackWarning[];
  /**
   * Runs it until it answers or hands calls back.
   *
   * @param listener - Hears its text and its events.
   * @param signal - The app's connection: aborting it cancels the run.
   * @returns How it ended, or that it waits. Never rejects: a failure is a failed run.
   */
  execute(listener: RunListener, signal: AbortSignal): Promise<FinishedRun>;
}

/** A run an earlier request with the same `Idempotency-Key` started. */
export interface RepeatedRun {
  kind: 'repeated';
  runId: string;
  /** Whether this request's body is the one the key was sent with. */
  matches: boolean;
  /**
   * Waits for the run to answer, if it is still going here, and reads it.
   *
   * @returns How it ended, or that it waits.
   */
  finished(): Promise<FinishedRun>;
}

/** Starts, resumes, records and answers agent runs. */
export interface RunService {
  /** A run's events, stored and live. */
  bus: RunBus;
  /** The remote workers runs are sent to, and their doors' view of the runs on them. */
  workers: RemoteWorkers;
  /**
   * Finds the run a workspace's `Idempotency-Key` belongs to.
   *
   * @param workspaceId - The key's workspace.
   * @param idempotency - The key and this request's hash.
   * @returns The run, or null when the key has started none.
   */
  repeatOf(workspaceId: string, idempotency: Idempotency): Promise<RepeatedRun | null>;
  /**
   * Records a new run, unless its `Idempotency-Key` already started one.
   *
   * @param input - The run.
   * @returns The new run, to execute at once, or the one the key started.
   * @throws {@link RunConflict} When the conversation has a run going or waiting, or the workspace's worker is offline
   * or busy. Nothing is recorded then.
   */
  begin(input: RunInput): Promise<StartedRun | RepeatedRun>;
  /**
   * Finds the waiting run that a request's tool messages answer.
   *
   * @param workspaceId - The key's workspace.
   * @param agentId - The agent the request names.
   * @param answers - The `tool` messages the request ends with.
   * @returns The run.
   * @throws {@link RequestRefusal} When they answer no waiting run, or only some of its calls, or more.
   * @throws {@link RunConflict} When the run they answer has expired, or isn't waiting any more.
   */
  waitingFor(workspaceId: string, agentId: string, answers: ToolAnswer[]): Promise<WaitingRun>;
  /**
   * Carries a waiting run on, with the app's answers, as the same run.
   *
   * @param input - The request that answers it, and the config resolved from the run's own layers.
   * @param waiting - The run, from `waitingFor`.
   * @returns The run, to execute at once.
   * @throws {@link RunConflict} When another request resumed it first, or the worker it ran on is offline or busy.
   */
  resume(input: RunInput, waiting: WaitingRun): Promise<StartedRun>;
  /**
   * Opens the conversation a request names, starting it if it is new or has expired.
   *
   * @param workspaceId - The key's workspace.
   * @param agent - The agent the request names.
   * @param key - The app's `X-Conversation-Id`.
   * @returns The conversation.
   * @throws {@link RequestRefusal} When it is with another agent.
   */
  openConversation(workspaceId: string, agent: SnapshotAgent, key: string): Promise<Conversation>;
  /**
   * Marks the runs a stopped router left `running` as failed. Waiting runs stay waiting. Call it at boot, before
   * the agents endpoint opens.
   *
   * @returns How many there were.
   */
  recover(): Promise<number>;
  /** Expires runs that waited past the wait timeout. */
  expire(): Promise<void>;
  /** Deletes ended runs past their retention and idle conversations, and frees keys past the idempotency window. */
  prune(): Promise<void>;
  /** Starts the timers that expire and prune. */
  start(): void;
  /**
   * Cancels a run that is going. A running run stops its loop and the model and tool calls it is making, and a
   * waiting one stops waiting. Either ends `cancelled`, with the reason as its error and a last `done` event.
   *
   * @param runId - The run.
   * @param reason - Why, as the run's error says it.
   * @returns The run as it stands once cancelled, or unchanged for one that had already ended. Undefined for no
   * such run.
   */
  cancel(runId: string, reason: string): Promise<RunRow | undefined>;
  /**
   * How a run going in this process ends: resolved once its end is recorded.
   *
   * @param runId - The run.
   * @returns Its end, or null for a run this process isn't running.
   */
  finishing(runId: string): Promise<FinishedRun> | null;
  /** Stops the timers, fails the runs still going, and waits for them to be recorded. Waiting runs stay waiting. */
  stop(): Promise<void>;
}

/** What the run service talks to. */
export interface RunServiceDeps {
  db: DB;
  snapshot: SnapshotHost;
  tools: ToolServices;
  /**
   * agent-core's caches for the runs.
   * @defaultValue a runtime of their own
   */
  runtime?: Runtime;
  /**
   * Where the loops of runs on `local` execute.
   * @defaultValue the `local` worker, in this process, with `runtime`
   */
  worker?: RunWorker;
  /**
   * The remote workers, for the runs of a workspace that names one.
   * @defaultValue none online, over a registry of this database's workers
   */
  workers?: RemoteWorkers;
  /** Settings that differ from `RUN_DEFAULTS`. */
  overrides?: Partial<RunSettings>;
  /** The clock retention and waiting are judged by. */
  now?: () => Date;
}

/** A run going in this process. */
interface LiveRun {
  /** Settles when it ends or waits. */
  finished: Promise<FinishedRun>;
  /** Cancels it, with the reason as the abort's. */
  cancel: AbortController;
  /** The request following it now. */
  hearing: Hearing;
}

/** A question a run is parked on: its loop is held, with the tool call open, until the app answers. */
interface ParkedQuestion {
  /** The reserved call's id, which the app answers. */
  callId: string;
  /** Hands the loop the app's answer. */
  answer: (content: string) => void;
}

/** Who a run is talking to. A run parked on a question outlives one request and carries on in the next. */
interface Hearing {
  listener: RunListener;
  /** Aborted when the request following the run leaves. */
  connection: AbortController;
  parked: ParkedQuestion | null;
  /**
   * Makes a request the one following the run.
   *
   * @param listener - Hears the run.
   * @param signal - The request's connection.
   * @returns How this stretch ends: the run's end, or its next wait.
   */
  attach(listener: RunListener, signal: AbortSignal): Promise<FinishedRun>;
  /**
   * Ends the stretch a request is following, and lets the request go.
   *
   * @param finished - How it ended.
   */
  endStretch(finished: FinishedRun): void;
  /**
   * Fails the stretch a request is following.
   *
   * @param error - What went wrong.
   */
  failStretch(error: unknown): void;
}

/** A tool the run reaches, with what the model is told about it. */
interface ReachedTool extends RunTool {
  /** Who answers it. For a local tool, `serverId` is the local server's name. */
  origin: ToolOrigin;
  description: string;
  parameters: Record<string, unknown>;
}

/** Where a run's stretch executes, and what narrows the worker's own servers. */
interface Placement {
  /** The remote worker. Null for `local`. */
  workerId: string | null;
  /** The servers the app narrowed the run to, or null for no narrowing. */
  servers: readonly string[] | null;
}

/** The tools a run reaches, named for its model, and what was left out. */
interface RunTools {
  definitions: ToolDefinition[];
  /** By function name. */
  names: Map<string, ReachedTool>;
  catalog: CatalogServer[];
  /** The app's tools this stretch hands back: those none of the agent's own tools answers. */
  appTools: AppTool[];
  /** The app's tools left out, because one of the agent's own answers each. */
  pruned: PrunedAppTool[];
  /** What the run's first events say was left out. */
  notices: string[];
}

/** One stretch of a run: from its start or a resume, to its answer or its next wait. */
interface Segment {
  input: RunInput;
  runId: string;
  startedAt: Date;
  /** The conversation the run's transcript is kept in. */
  conversationId: string | null;
  tools: RunTools;
  /** The app's tools as the request sent them, pruned ones included, kept for the run's next wait. */
  appTools: AppTool[];
  /** The transcript the loop carries on from. */
  messages: ChatMessage[];
  loaded: string[];
  /** The app's answers this stretch delivers, told as events before it starts. */
  answered: { call: HandedBackCall; content: string }[];
  /** Tokens the run spent before this stretch. */
  spent: { input: number; output: number };
  /** The layers the run started with, kept for its next wait. */
  layers: Pick<RunResume, 'systemText' | 'appParts' | 'servers' | 'sampling'>;
  /** The remote worker it runs on. Null for `local`. */
  workerId: string | null;
}

/**
 * Files a called agent's event under the call that ran it.
 *
 * @param event - The event, as the called run's server sent it.
 * @param callId - The call.
 * @param heard - The last `seq` heard from each run during this call. Updated.
 * @returns The event to publish, or null for a repeat, or for one nested deeper than agents may call.
 *
 * @remarks
 * `tasks/result` starts from a run's first event each time a quiet task is asked again, so repeats are dropped by
 * `seq`. The server is untrusted, and a `via` longer than the limit could only be made up.
 */
function nestedEvent(event: RunEvent, callId: string, heard: Map<string, number>): RunEventInput | null {
  const isRepeat = event.seq <= (heard.get(event.runId) ?? 0);
  const isTooDeep = (event.via?.length ?? 0) >= RUN_DEFAULTS.maxAgentDepth;
  if (isRepeat || isTooDeep) {
    return null;
  }
  heard.set(event.runId, event.seq);
  return nestEvent(event, { runId: event.runId, callId });
}

/**
 * Builds a run's hearing, with nobody following it yet.
 *
 * @returns The hearing.
 */
function createHearing(): Hearing {
  const silent: RunListener = { onText: () => {}, onEvent: () => {} };
  const connection = new AbortController();
  let unlink = () => {};
  let settle: (finished: FinishedRun) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const hearing: Hearing = {
    listener: silent,
    connection,
    parked: null,
    attach(listener, signal) {
      unlink();
      hearing.listener = listener;
      const onLeft = () => connection.abort();
      if (signal.aborted) {
        onLeft();
      } else {
        signal.addEventListener('abort', onLeft, { once: true });
        unlink = () => signal.removeEventListener('abort', onLeft);
      }
      return new Promise((resolve, fail) => {
        settle = resolve;
        reject = fail;
      });
    },
    endStretch(finished) {
      unlink();
      unlink = () => {};
      hearing.listener = silent;
      settle(finished);
    },
    failStretch(error) {
      unlink();
      reject(error);
    },
  };
  return hearing;
}

/**
 * Reads the run a tool call started, when the tool is an agent behind a router's `/mcp`.
 *
 * @param result - What the tool answered.
 * @returns The called agent's run id, from the answer's `_meta.runId`, or null for any other tool.
 */
function calledRunOf(result: CallToolResult): string | null {
  const parsed = runIdSchema.safeParse(result._meta?.runId);
  return parsed.success ? parsed.data : null;
}

/**
 * Reads a stored run as an ended or waiting one.
 *
 * @param row - The run's row.
 * @returns The run.
 */
function finishedFrom(row: RunRow): FinishedRun {
  return {
    runId: row.id,
    agentName: row.agentName,
    status: row.status,
    startedAt: row.startedAt,
    answer: row.answer,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    error: row.error,
  };
}

/**
 * Renames tool calls in a transcript, for the calls handed back under ids the router minted.
 *
 * @param messages - The transcript.
 * @param ids - The new id for each loop id that has one.
 * @returns A copy, with each call and the result that answers it under its new id.
 */
function withCallIds(messages: ChatMessage[], ids: ReadonlyMap<string, string>): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.tool_calls !== undefined) {
      const renamed = message.tool_calls.map((call) => ({ ...call, id: ids.get(call.id) ?? call.id }));
      return { ...message, tool_calls: renamed };
    }
    if (message.role === 'tool') {
      return { ...message, tool_call_id: ids.get(message.tool_call_id) ?? message.tool_call_id };
    }
    return message;
  });
}

/**
 * Finds the handed-back calls in a transcript, as the model made them.
 *
 * @param messages - The transcript, under the minted ids.
 * @param ids - The handed-back calls' ids, in the order they were made.
 * @returns The calls, in OpenAI's shape.
 */
function handedBackCalls(messages: ChatMessage[], ids: readonly string[]): HandedBackCall[] {
  const made = new Map<string, HandedBackCall>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        if (call.type === 'function') {
          made.set(call.id, { id: call.id, type: 'function', function: call.function });
        }
      }
    }
  }
  return ids.flatMap((id) => made.get(id) ?? []);
}

/**
 * Builds the run service.
 *
 * @param deps - The database, the snapshot, the tools area, and stand-ins for tests.
 * @returns The service, with its timers not yet started.
 */
export function createRunService({
  db,
  snapshot,
  tools,
  runtime = createRuntime(),
  worker = createLocalWorker(runtime),
  workers = createRemoteWorkers(createWorkerRegistry(db)),
  overrides = {},
  now = () => new Date(),
}: RunServiceDeps): RunService {
  const settings = { ...RUN_DEFAULTS, ...overrides };
  const bus = createRunBus(db, overrides);
  /** Runs going in this process, by id: what a repeated key waits on, and a cancel stops. */
  const live = new Map<string, LiveRun>();
  /** Fails every run still going when the router stops. */
  const stopping = new AbortController();
  const timers: NodeJS.Timeout[] = [];

  const readRun = async (runId: string): Promise<RunRow | undefined> => {
    const [row] = await db.select().from(runs).where(eq(runs.id, runId));
    return row;
  };

  const repeatOf = async (workspaceId: string, { key, hash }: Idempotency): Promise<RepeatedRun | null> => {
    const [row] = await db
      .select({ id: runs.id, requestHash: runs.requestHash })
      .from(runs)
      .where(and(eq(runs.workspaceId, workspaceId), eq(runs.idempotencyKey, key)));
    if (row === undefined) {
      return null;
    }
    const runId = row.id;
    return {
      kind: 'repeated',
      runId,
      matches: row.requestHash === hash,
      finished: async () => {
        const going = live.get(runId);
        // A run parked on a question has answered this key's request with that question, which is stored.
        if (going !== undefined && going.hearing.parked === null) {
          return going.finished;
        }
        const stored = await readRun(runId);
        if (stored === undefined) {
          throw new Error(`Run ${runId} is gone.`);
        }
        return finishedFrom(stored);
      },
    };
  };

  /**
   * Reads the tools of a remote worker's own servers, as its last hello said them.
   *
   * @param placement - The worker, and the servers the app narrowed the run to.
   * @param routerServers - The names of the router's servers the run reaches, which win over a local one's.
   * @param notices - What the run's first events say was left out. Added to.
   * @returns The local tools the run reaches: none on `local`.
   */
  const localTools = (
    { workerId, servers: narrowed }: Placement,
    routerServers: ReadonlySet<string>,
    notices: string[],
  ): ReachedTool[] => {
    const offered = workerId === null ? [] : workers.registry.localServers(workerId);
    return offered.flatMap((server): ReachedTool[] => {
      const isNarrowedAway = narrowed !== null && narrowed.includes(server.name) === false;
      if (isNarrowedAway) {
        return [];
      }
      const named = localServerName.safeParse(server.name);
      if (named.success === false || named.data !== server.name) {
        notices.push(`the worker's server "${server.name}" is left out: its name breaks the router's name rule.`);
        return [];
      }
      if (routerServers.has(server.name)) {
        notices.push(`the worker's server "${server.name}" is left out: the router's server of that name is used.`);
        return [];
      }
      return server.tools.map((tool) => ({
        origin: TOOL_ORIGIN_LOCAL,
        serverId: server.name,
        serverName: server.name,
        tool: tool.name,
        description: tool.description ?? '',
        parameters: tool.inputSchema,
      }));
    });
  };

  /**
   * Refuses a run whose worker can't take it: a remote worker that is offline, or running as many runs as it may.
   *
   * @param workerId - The remote worker, or null for `local`, which always can.
   * @throws {@link RunConflict} When it is offline or busy.
   */
  const checkWorker = (workerId: string | null): void => {
    if (workerId === null) {
      return;
    }
    const name = snapshot.current().workers.get(workerId)?.name ?? workerId;
    if (workers.registry.isOnline(workerId) === false) {
      throw new RunConflict(
        ModelFailure.WorkerOffline,
        `Worker ${name}, where this workspace's runs go, is offline. Start it, or try again once it has dialled in.`,
      );
    }
    const { maxRunsAtOnce } = workers.settings;
    if (workers.runsOn(workerId) >= maxRunsAtOnce) {
      throw new RunConflict(
        ModelFailure.WorkerBusy,
        `Worker ${name} is running ${maxRunsAtOnce} runs, as many as it may at once. Try again when one ends.`,
      );
    }
  };

  /**
   * Lists the tools of every server the run reaches, as its workspace's instances, and names them for the model.
   *
   * @param input - The run: its resolved agent, for its servers, and its workspace, whose instances to use.
   * @param sent - The app's own tools, as the request sent them.
   * @param placement - The remote worker the run is on, whose local servers it reaches too, and the servers the app
   * narrowed it to (null for no narrowing), which narrow those as well.
   * @returns The tools, with the app's that duplicate one of them left out. A server that can't start or list is left
   * out and said so, never failing the run.
   *
   * @remarks
   * A tool turned off for the agent in its workspace is left out as each server is listed, before the tools are named,
   * so it takes no name and no slot in the catalogue, and an app tool that duplicates it is kept. Those switches don't
   * reach a worker's local servers, which the router knows only by what the worker says.
   */
  const reachedTools = async (
    { config, workspace, agent }: RunInput,
    sent: AppTool[],
    placement: Placement,
  ): Promise<RunTools> => {
    const workspaceId = workspace.id;
    const notices: string[] = [];
    const reach = reachOf(config.servers, snapshot.current());
    const disabledTools = agent.disabledTools.get(workspaceId);
    for (const name of reach.missing) {
      notices.push(`server "${name}" is not on this router or is turned off; it is left out.`);
    }
    const local = localTools(placement, new Set(reach.servers.map((server) => server.name)), notices);
    const listed = await Promise.all(
      reach.servers.map(async (server): Promise<ReachedTool[]> => {
        try {
          const served = await tools.listTools(server.id, workspaceId);
          const off = disabledTools?.get(server.name);
          const kept = off === undefined ? served : served.filter((tool) => off.has(tool.name) === false);
          return kept.map((tool) => ({
            origin: TOOL_ORIGIN_ROUTER,
            serverId: server.id,
            serverName: server.name,
            tool: tool.name,
            description: tool.description ?? tool.title ?? '',
            parameters: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object' },
          }));
        } catch (error) {
          console.warn(`[runs] a run leaves server ${server.name} out: ${errorMessage(error)}`);
          notices.push(
            `server "${server.name}" could not list its tools, so they are left out: ${errorMessage(error)}`,
          );
          return [];
        }
      }),
    );
    const { names, dropped } = runToolNames([...listed.flat(), ...local]);
    for (const tool of dropped) {
      notices.push(`tool "${tool.tool}" of server "${tool.serverName}" is left out: its name clashes with another.`);
    }
    const { pruneAppToolsAcrossServers } = snapshot.current().settings;
    const { kept, pruned } = pruneAppTools(sent, names, pruneAppToolsAcrossServers);
    for (const { name, agentTool, acrossServers } of pruned) {
      if (acrossServers) {
        // A guess, so every one is in the log.
        console.info(
          `[runs] agent ${agent.name} for workspace ${workspace.slug} leaves out app tool ${name}: its own ${agentTool} is the same tool under another server's name.`,
        );
        notices.push(`app tool "${name}" is left out: the agent's "${agentTool}" is the same tool, and answers it.`);
      } else {
        notices.push(`app tool "${name}" is left out: the agent's own tool of that name answers it.`);
      }
    }
    const definitions: ToolDefinition[] = [...names].map(([name, tool]) => ({
      type: 'function',
      function: { name, description: tool.description, parameters: tool.parameters },
    }));
    const byServer = new Map<string, CatalogServer>();
    for (const [name, tool] of names) {
      const entry = byServer.get(tool.serverName) ?? { id: tool.serverName, label: tool.serverName, tools: [] };
      entry.tools.push({ name, description: tool.description });
      byServer.set(tool.serverName, entry);
    }
    return { definitions, names, catalog: [...byServer.values()], appTools: kept, pruned, notices };
  };

  /**
   * Records how a run ended. Only a run still `running` is written, so an ended run never changes.
   *
   * @param finished - How it ended.
   */
  const record = async (finished: FinishedRun): Promise<void> => {
    try {
      await db
        .update(runs)
        .set({
          status: finished.status,
          finishedAt: now(),
          inputTokens: finished.inputTokens,
          outputTokens: finished.outputTokens,
          error: finished.error?.slice(0, settings.maxErrorLength) ?? null,
          answer: finished.answer,
          resume: null,
        })
        .where(and(eq(runs.id, finished.runId), eq(runs.status, RunStatus.Running)));
    } catch (error) {
      console.error(`[runs] could not record how run ${finished.runId} ended: ${errorMessage(error)}`);
    }
  };

  /**
   * Records that a run waits for the app, with what it needs to carry on.
   *
   * @param finished - The run, with the calls it hands back.
   * @param resume - What it needs to carry on.
   */
  const recordWait = async (finished: FinishedRun, resume: RunResume): Promise<void> => {
    try {
      await db
        .update(runs)
        .set({
          status: RunStatus.Waiting,
          waitingSince: now(),
          pendingCallIds: resume.handedBack.map((call) => call.id),
          inputTokens: finished.inputTokens,
          outputTokens: finished.outputTokens,
          answer: finished.answer,
          resume,
        })
        .where(and(eq(runs.id, finished.runId), eq(runs.status, RunStatus.Running)));
    } catch (error) {
      console.error(`[runs] could not record that run ${finished.runId} waits: ${errorMessage(error)}`);
    }
  };

  /**
   * Keeps a run's transcript in its conversation, or only moves the conversation's expiry on.
   *
   * @param conversationId - The conversation, or null for a stateless run.
   * @param kept - The transcript and system messages of a run that answered, or null for one that didn't.
   */
  const keepConversation = async (
    conversationId: string | null,
    kept: { messages: ChatMessage[]; systemText: string | null } | null,
  ): Promise<void> => {
    if (conversationId === null) {
      return;
    }
    try {
      if (kept === null) {
        await touchConversation(db, conversationId, now());
      } else {
        await saveConversation(db, conversationId, kept.messages, kept.systemText, now());
      }
    } catch (error) {
      console.error(`[runs] could not keep conversation ${conversationId}: ${errorMessage(error)}`);
    }
  };

  /**
   * Runs one stretch of a run: to its answer, or until the model calls an app tool and the run waits.
   *
   * @param segment - The stretch.
   * @param hearing - Who hears the answer's text and the run's events, and whose leaving cancels it.
   * @param cancelled - Aborted, with the reason, when the run is cancelled.
   * @returns How it ended, or that it waits.
   */
  const run = async (segment: Segment, hearing: Hearing, cancelled: AbortSignal): Promise<FinishedRun> => {
    const { input, runId, spent } = segment;
    const { appTools } = segment.tools;
    const { workspace, agent, config } = input;
    const deadline = AbortSignal.timeout(settings.timeoutMinutes * MS_PER_MINUTE);
    const runSignal = AbortSignal.any([hearing.connection.signal, cancelled, deadline, stopping.signal]);
    const say = (event: RunEventInput): RunEvent => {
      const published = bus.publish(runId, event);
      hearing.listener.onEvent(published);
      return published;
    };
    if (segment.workerId !== null) {
      const name = snapshot.current().workers.get(segment.workerId)?.name ?? segment.workerId;
      const host = workers.registry.host(segment.workerId);
      say({ kind: RunEventKind.Notice, text: `Running on worker ${name}${host === null ? '' : ` (${host})`}` });
    }
    for (const text of [...segment.tools.notices, ...input.prompt.warnings.map((warning) => warning.message)]) {
      say({ kind: RunEventKind.Notice, text });
    }
    for (const { call, content } of segment.answered) {
      say({ kind: RunEventKind.ToolResult, id: call.id, name: call.function.name, ok: true, text: preview(content) });
    }

    const appNames = new Set(appTools.map((tool) => tool.function.name));
    // The app answers its calls by id, so each is handed back under an id the router minted, which no other run
    // is waiting on. Every app tool call is renamed, in the events and the transcript alike.
    const taken = callIdsIn(segment.messages);
    const minted = new Map<string, string>();
    const mintedFor = (loopId: string): string => {
      const known = minted.get(loopId);
      if (known !== undefined) {
        return known;
      }
      const id = freshCallId(taken);
      minted.set(loopId, id);
      return id;
    };

    let answer = '';
    let isNewTurn = false;
    let counted = Promise.resolve();
    let usedSoFar: { promptTokens: number; completionTokens: number } | undefined;
    // What the router does with each of the loop's events, wherever the loop runs.
    const heard = (event: RunEventInput): RunEvent => {
      const isAppCall =
        (event.kind === RunEventKind.ToolCall || event.kind === RunEventKind.ToolResult) &&
        event.id !== undefined &&
        appNames.has(event.name ?? '');
      if (isAppCall && event.id !== undefined) {
        return say({ ...event, id: mintedFor(event.id) });
      }
      const published = say(event);
      if (event.kind === RunEventKind.Turn) {
        isNewTurn = answer !== '';
      }
      const { usage } = event;
      if (event.kind === RunEventKind.Usage && usage !== undefined && usage !== null) {
        usedSoFar = usage;
        // So a run's record shows what it has spent while it runs.
        const totals = {
          inputTokens: spent.input + usage.promptTokens,
          outputTokens: spent.output + usage.completionTokens,
        };
        counted = counted
          .then(() =>
            db
              .update(runs)
              .set(totals)
              .where(and(eq(runs.id, runId), eq(runs.status, RunStatus.Running))),
          )
          .then(
            () => {},
            (error) => console.warn(`[runs] could not count run ${runId}'s tokens: ${errorMessage(error)}`),
          );
      }
      const text = event.text ?? '';
      if (event.kind === RunEventKind.Output && text !== '') {
        const delta = isNewTurn ? `${TURN_JOIN}${text}` : text;
        isNewTurn = false;
        answer += delta;
        hearing.listener.onText(delta);
      }
      return published;
    };
    const ended = (status: RunStatus, usage: { promptTokens: number; completionTokens: number } | undefined) => ({
      runId,
      agentName: agent.name,
      status,
      startedAt: segment.startedAt,
      inputTokens: spent.input + (usage?.promptTokens ?? 0),
      outputTokens: spent.output + (usage?.completionTokens ?? 0),
    });
    let unparked = Promise.resolve();
    /**
     * Takes the run off a question that will get no answer, so it can carry on or end.
     *
     * @returns Resolves once the run is recorded as running again.
     */
    const unpark = (): Promise<void> => {
      if (hearing.parked === null) {
        return unparked;
      }
      hearing.parked = null;
      unparked = db
        .update(runs)
        .set({ status: RunStatus.Running, pendingCallIds: [], resume: null })
        .where(and(eq(runs.id, runId), eq(runs.status, RunStatus.Waiting)))
        .then(
          () => {},
          (error) => console.error(`[runs] could not take run ${runId} off its question: ${errorMessage(error)}`),
        );
      return unparked;
    };
    /**
     * Ends the app's response with the reserved call and holds the tool call open until the next request answers it.
     *
     * @param params - The server's question.
     * @param questionSignal - Aborted when the answer is no longer wanted.
     * @returns The app's answer, or a decline.
     */
    const parkOn = async (params: ElicitRequest['params'], questionSignal: AbortSignal): Promise<ElicitResult> => {
      if (questionSignal.aborted) {
        return DECLINED;
      }
      const call: HandedBackCall = {
        id: freshCallId(taken),
        type: 'function',
        function: { name: ELICIT_TOOL, arguments: JSON.stringify(params) },
      };
      const answered = new Promise<string>((resolve) => {
        hearing.parked = { callId: call.id, answer: resolve };
      });
      const waiting: FinishedRun = {
        ...ended(RunStatus.Waiting, usedSoFar),
        answer: { content: answer, finishReason: FINISH_TOOL_CALLS, toolCalls: [call] },
        error: null,
      };
      await counted;
      await recordWait(waiting, {
        messages: [],
        handedBack: [call],
        appTools: segment.appTools,
        loaded: segment.loaded,
        ...segment.layers,
        parked: true,
      });
      answer = '';
      isNewTurn = false;
      hearing.endStretch(waiting);
      const withdrawn = new Promise<null>((resolve) => {
        if (questionSignal.aborted) {
          resolve(null);
        }
        questionSignal.addEventListener('abort', () => resolve(null), { once: true });
      });
      const content = await Promise.race([answered, withdrawn]);
      if (content === null) {
        await unpark();
        return DECLINED;
      }
      return answerOf(content);
    };
    let parkTurn: Promise<unknown> = Promise.resolve();
    // An app answers one question per response, so a second call's question waits for the first's answer.
    const parkInTurn: ToolElicit = (params, { signal: questionSignal }) => {
      const turn = parkTurn.then(() => parkOn(params, questionSignal));
      parkTurn = turn.catch(() => {});
      return turn;
    };
    const asks = hearing.listener.onElicit ?? (input.request.progress ? parkInTurn : undefined);
    const callRouterTool: RunPorts['callRouterTool'] = async (serverId, tool, args, { call, signal }) => {
      const nestedSeqs = new Map<string, number>();
      const onElicit: ToolElicit | undefined =
        asks &&
        (async (params, options) => {
          say({ kind: RunEventKind.Elicit, id: call.id, name: call.name, text: params.message });
          const said = await asks(params, options);
          const fields = answeredFields(params, said);
          say({
            kind: RunEventKind.ElicitAnswer,
            id: call.id,
            name: call.name,
            text: said.action,
            ...(fields.length > 0 ? { fields } : {}),
          });
          return said;
        });
      const result = await tools.callTool(serverId, workspace.id, tool, args, {
        agentId: agent.id,
        agentName: agent.name,
        runId,
        workspaceId: workspace.id,
        signal,
        depth: input.depth + 1,
        ...(onElicit === undefined ? {} : { onElicit }),
        onProgress: (progress) => {
          if (progress.event === undefined) {
            say({ kind: RunEventKind.Notice, id: call.id, name: call.name, text: progress.message });
            return;
          }
          const nested = nestedEvent(progress.event, call.id, nestedSeqs);
          if (nested !== null) {
            say(nested);
          }
        },
      });
      const childRunId = calledRunOf(result);
      if (childRunId !== null) {
        say({
          kind: RunEventKind.Notice,
          id: call.id,
          name: call.name,
          text: `${call.name} ran as run ${childRunId}.`,
          link: { name: childRunId, uri: `${RUN_RECORD_PATH}${childRunId}` },
        });
      }
      if (isToolError(result)) {
        throw new Error(toolResultText(result));
      }
      return toolResultContent(result);
    };
    /**
     * Ends a stretch that failed or was stopped, by what stopped it.
     *
     * @param usage - What the model spent, when the loop knows.
     * @param error - What went wrong, for a failure nothing stopped.
     * @returns The ended run.
     */
    const stopped = (usage: LoopUsage | undefined, error: string): FinishedRun => {
      if (cancelled.aborted) {
        return { ...ended(RunStatus.Cancelled, usage), answer: null, error: String(cancelled.reason) };
      }
      if (hearing.connection.signal.aborted) {
        return { ...ended(RunStatus.Cancelled, usage), answer: null, error: 'The app disconnected.' };
      }
      if (deadline.aborted) {
        const late = `The run took longer than ${settings.timeoutMinutes} minutes.`;
        return { ...ended(RunStatus.Failed, usage), answer: null, error: late };
      }
      if (stopping.signal.aborted) {
        return { ...ended(RunStatus.Failed, usage), answer: null, error: 'The router stopped while it ran.' };
      }
      return { ...ended(RunStatus.Failed, usage), answer: null, error };
    };
    const reached = segment.tools;
    const assignment: RunAssignment = {
      runId,
      config,
      prompt: input.prompt.parts,
      messages: segment.messages,
      loaded: segment.loaded,
      tools: reached.definitions,
      catalog: reached.catalog,
      targets: Object.fromEntries(
        [...reached.names].map(([name, tool]) => [
          name,
          { origin: tool.origin, server: tool.serverId, tool: tool.tool },
        ]),
      ),
      appTools,
    };
    let finished: FinishedRun;
    try {
      const runsOn = segment.workerId === null ? worker : workers.worker(segment.workerId);
      const outcome = await runsOn.execute(assignment, {
        modelFetch: input.modelFetch,
        callRouterTool,
        publish: heard,
        signal: runSignal,
      });
      if (outcome.ok) {
        // A cancel that came as the loop ended still cancels: the run hasn't answered yet.
        cancelled.throwIfAborted();
        await unpark();
        const handedIds = outcome.handedBack.map((id) => mintedFor(id));
        const transcript = withCallIds(outcome.messages, minted);
        if (handedIds.length > 0) {
          const handedBack = handedBackCalls(transcript, handedIds);
          finished = {
            ...ended(RunStatus.Waiting, outcome.usage),
            answer: { content: answer, finishReason: FINISH_TOOL_CALLS, toolCalls: handedBack },
            error: null,
          };
          const count = handedBack.length === 1 ? 'the call' : `${handedBack.length} calls`;
          say({ kind: RunEventKind.Notice, text: `the run waits for the app to answer ${count} it handed back.` });
          await counted;
          await keepConversation(segment.conversationId, null);
          await recordWait(finished, {
            messages: transcript,
            handedBack,
            appTools: segment.appTools,
            loaded: outcome.loaded,
            ...segment.layers,
          });
          await bus.close(runId);
          return finished;
        }
        const finishReason = outcome.finishReason === FINISH_LENGTH ? FINISH_LENGTH : FINISH_STOP;
        finished = {
          ...ended(RunStatus.Completed, outcome.usage),
          answer: { content: answer, finishReason },
          error: null,
        };
        await keepConversation(segment.conversationId, { messages: transcript, systemText: segment.layers.systemText });
      } else {
        finished = stopped(outcome.usage, outcome.error);
      }
    } catch (error) {
      finished = stopped(failedRun(error)?.usage, errorMessage(error));
    }
    await unpark();
    const isCompleted = finished.status === RunStatus.Completed;
    if (isCompleted === false) {
      // A failed run adds nothing, so a retry of the same new message isn't in the history twice.
      await keepConversation(segment.conversationId, null);
    }
    say({ kind: RunEventKind.Done, ok: isCompleted, text: finished.error ?? '' });
    await counted;
    await record(finished);
    await bus.close(runId);
    return finished;
  };

  /**
   * Hands a run's stretch to the request that started or resumed it, and to any repeat of its key meanwhile.
   *
   * @param segment - The stretch.
   * @returns The run, to execute.
   */
  const started = (segment: Segment): StartedRun => {
    let settle: (finished: FinishedRun) => void = () => {};
    const cancel = new AbortController();
    const ending = new Promise<FinishedRun>((resolve) => {
      settle = resolve;
    });
    const hearing = createHearing();
    live.set(segment.runId, { finished: ending, cancel, hearing });
    return {
      kind: 'started',
      runId: segment.runId,
      startedAt: segment.startedAt,
      prunedTools: segment.tools.pruned.map((tool) => tool.name),
      warnings: segment.input.prompt.warnings,
      execute: (listener, signal) => {
        const stretch = hearing.attach(listener, signal);
        run(segment, hearing, cancel.signal).then(
          (finished) => {
            settle(finished);
            live.delete(segment.runId);
            hearing.endStretch(finished);
          },
          (error: unknown) => hearing.failStretch(error),
        );
        return stretch;
      },
    };
  };

  /**
   * Refuses a request to a conversation that already has a run going or waiting.
   *
   * @param conversation - The conversation.
   * @returns Nothing: it always throws.
   * @throws {@link RunConflict} Always.
   */
  const conversationBusy = async (conversation: Conversation): Promise<never> => {
    const busy = await busyRun(db, conversation.id);
    const which = busy === null ? 'a run' : `run ${busy.id} ${busy.status}`;
    throw new RunConflict(
      ModelFailure.ConversationBusy,
      `Conversation "${conversation.key}" has ${which}. One run at a time: wait for its answer, or answer the calls it handed back.`,
    );
  };

  const begin = async (input: RunInput): Promise<StartedRun | RepeatedRun> => {
    const { workspace, agent, request, idempotency, conversation } = input;
    const isBusy = conversation !== null && (await busyRun(db, conversation.id)) !== null;
    if (isBusy) {
      await conversationBusy(conversation);
    }
    const { workerId } = workspace;
    checkWorker(workerId);
    const reached = await reachedTools(input, request.appTools, { workerId, servers: request.servers });
    let inserted: RunRow[];
    try {
      inserted = await db
        .insert(runs)
        .values({
          workspaceId: workspace.id,
          workspaceName: workspace.slug,
          agentId: agent.id,
          agentName: agent.name,
          revisionId: agent.liveRevisionId,
          conversationId: conversation?.id ?? null,
          sessionKey: input.sessionKey,
          // Null for `local`, as a workspace names it.
          workerId,
          input: request.input,
          user: request.user,
          stream: request.stream,
          idempotencyKey: idempotency?.key ?? null,
          requestHash: idempotency?.hash ?? null,
        })
        .onConflictDoNothing({ target: [runs.workspaceId, runs.idempotencyKey] })
        .returning();
    } catch (error) {
      // Two requests to one conversation at once: the index lets one in.
      if (conversation !== null && violatedUniqueIndex(error) === ONE_RUN_PER_CONVERSATION) {
        return conversationBusy(conversation);
      }
      throw error;
    }
    const [row] = inserted;
    if (row === undefined) {
      // Another request with the same key got there first.
      const repeat = idempotency === null ? null : await repeatOf(workspace.id, idempotency);
      if (repeat === null) {
        throw new Error('The run was not recorded, and no run holds its key.');
      }
      return repeat;
    }
    const { systemText, appParts, servers, sampling } = request;
    // Live before anything else is awaited, so a cancel from now on finds it.
    const handle = started({
      input,
      runId: row.id,
      startedAt: row.startedAt,
      conversationId: row.conversationId,
      tools: reached,
      appTools: request.appTools,
      messages: request.messages,
      loaded: [],
      answered: [],
      spent: { input: 0, output: 0 },
      layers: { systemText, appParts, servers, sampling },
      workerId,
    });
    await bus.open(row.id);
    return handle;
  };

  /**
   * Expires runs that wait past the timeout, and says so in their events.
   *
   * @param [runId] - Only this run, when a late answer finds it overdue.
   * @returns The runs expired.
   */
  const expireOverdue = async (runId?: string): Promise<string[]> => {
    const cutoff = new Date(now().getTime() - settings.waitTimeoutHours * MS_PER_HOUR);
    const error = `The run waited longer than ${settings.waitTimeoutHours} hours for the app to answer its tool calls.`;
    const expired = await db
      .update(runs)
      .set({ status: RunStatus.Expired, finishedAt: now(), error, resume: null })
      .where(
        and(
          eq(runs.status, RunStatus.Waiting),
          lt(runs.waitingSince, cutoff),
          runId === undefined ? undefined : eq(runs.id, runId),
        ),
      )
      .returning({ id: runs.id });
    for (const { id } of expired) {
      await bus.open(id);
      bus.publish(id, { kind: RunEventKind.Done, ok: false, text: error });
      await bus.close(id);
    }
    return expired.map(({ id }) => id);
  };

  const waitingFor = async (workspaceId: string, agentId: string, answers: ToolAnswer[]): Promise<WaitingRun> => {
    const answeredIds = answers.map((answer) => answer.callId);
    const found = await db
      .select({ id: runs.id, status: runs.status, pendingCallIds: runs.pendingCallIds, error: runs.error })
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, workspaceId),
          eq(runs.agentId, agentId),
          arrayOverlaps(runs.pendingCallIds, answeredIds),
        ),
      );
    const [match, other] = found;
    if (match === undefined) {
      throw new RequestRefusal(
        'messages',
        'messages: the tool messages at the end answer calls no run of this agent handed back. Answer the calls of the last answer, under their ids.',
      );
    }
    if (other !== undefined) {
      throw new RequestRefusal('messages', 'messages: the tool messages at the end answer calls of more than one run.');
    }
    const isOverdue = match.status === RunStatus.Waiting && (await expireOverdue(match.id)).length > 0;
    if (match.status === RunStatus.Expired || isOverdue) {
      throw new RunConflict(
        ModelFailure.RunExpired,
        `Run ${match.id} waited too long for these answers and has expired. Start again with a new request.`,
      );
    }
    if (match.status === RunStatus.Cancelled) {
      throw new RunConflict(ModelFailure.RunCancelled, `Run ${match.id} was cancelled: ${match.error ?? ''}`);
    }
    if (match.status !== RunStatus.Waiting) {
      throw new RunConflict(ModelFailure.RunInProgress, `Run ${match.id} isn't waiting for these answers any more.`);
    }
    const pending = new Set(match.pendingCallIds);
    const unanswered = match.pendingCallIds.filter((id) => answeredIds.includes(id) === false);
    if (unanswered.length > 0) {
      throw new RequestRefusal(
        'messages',
        `messages: answer every call the run handed back. These have no tool message: ${unanswered.join(', ')}.`,
      );
    }
    const extra = answeredIds.filter((id) => pending.has(id) === false);
    if (extra.length > 0 || answeredIds.length !== new Set(answeredIds).size) {
      throw new RequestRefusal(
        'messages',
        `messages: the tool messages at the end answer each handed-back call once, and nothing else. Not handed back: ${extra.join(', ') || 'none'}.`,
      );
    }
    const [row] = await db
      .select({
        resume: runs.resume,
        conversationId: runs.conversationId,
        workerId: runs.workerId,
        document: agentRevisions.document,
      })
      .from(runs)
      .leftJoin(agentRevisions, eq(agentRevisions.id, runs.revisionId))
      .where(eq(runs.id, match.id));
    if (row?.resume === null || row?.resume === undefined) {
      throw new RunConflict(ModelFailure.RunInProgress, `Run ${match.id} isn't waiting for these answers any more.`);
    }
    if (row.document === null) {
      throw new RunConflict(ModelFailure.RunFailed, `Run ${match.id} can't carry on: the revision it ran is gone.`);
    }
    return {
      runId: match.id,
      conversationId: row.conversationId,
      resume: row.resume,
      document: row.document,
      workerId: row.workerId,
    };
  };

  /**
   * Hands an app's answer to the run parked on its question, which carries on in this request.
   *
   * @param input - The request that answers it.
   * @param waiting - The run.
   * @returns The run, to follow. Its answer is never recorded: it can hold what a person typed.
   * @throws {@link RunConflict} When the question has lapsed, or another request answered it first.
   */
  const resumeParked = async ({ request, idempotency }: RunInput, waiting: WaitingRun): Promise<StartedRun> => {
    const going = live.get(waiting.runId);
    const parked = going?.hearing.parked ?? null;
    const [reply] = request.answers;
    if (going === undefined || parked === null || reply === undefined || reply.callId !== parked.callId) {
      throw new RunConflict(ModelFailure.RunInProgress, `Run ${waiting.runId} isn't waiting for this answer any more.`);
    }
    const [row] = await db
      .update(runs)
      .set({
        status: RunStatus.Running,
        pendingCallIds: [],
        resume: null,
        idempotencyKey: idempotency?.key ?? null,
        requestHash: idempotency?.hash ?? null,
      })
      .where(and(eq(runs.id, waiting.runId), eq(runs.status, RunStatus.Waiting)))
      .returning();
    if (row === undefined) {
      throw new RunConflict(ModelFailure.RunInProgress, `Run ${waiting.runId} has already been resumed.`);
    }
    going.hearing.parked = null;
    return {
      kind: 'started',
      runId: row.id,
      startedAt: row.startedAt,
      prunedTools: [],
      warnings: [],
      execute: (listener, signal) => {
        const stretch = going.hearing.attach(listener, signal);
        parked.answer(reply.content);
        return stretch;
      },
    };
  };

  const resume = async (input: RunInput, waiting: WaitingRun): Promise<StartedRun> => {
    if (waiting.resume.parked === true) {
      return resumeParked(input, waiting);
    }
    const { request, idempotency } = input;
    const state = waiting.resume;
    // The app sends its tools again with every request, as any OpenAI client does. One that doesn't keeps them.
    // They are pruned again, by the same rules, against the agent's tools as they are now.
    const appTools = request.appTools.length > 0 ? request.appTools : state.appTools;
    // It carries on where it ran, not where its workspace's runs go now.
    const { workerId } = waiting;
    checkWorker(workerId);
    const reached = await reachedTools(input, appTools, { workerId, servers: state.servers });
    const [row] = await db
      .update(runs)
      .set({
        status: RunStatus.Running,
        pendingCallIds: [],
        resume: null,
        // Each resume's answers follow what the run was given before.
        input: sql`${runs.input} || ${JSON.stringify(request.input)}::jsonb`,
        // The run answers to the key of its latest request, which is the one a retry repeats.
        idempotencyKey: idempotency?.key ?? null,
        requestHash: idempotency?.hash ?? null,
      })
      .where(and(eq(runs.id, waiting.runId), eq(runs.status, RunStatus.Waiting)))
      .returning();
    if (row === undefined) {
      throw new RunConflict(ModelFailure.RunInProgress, `Run ${waiting.runId} has already been resumed.`);
    }
    const answers = new Map(request.answers.map((answer) => [answer.callId, answer.content]));
    const messages = state.messages.map((message) => {
      const content = message.role === 'tool' ? answers.get(message.tool_call_id) : undefined;
      return content === undefined ? message : { ...message, content };
    });
    // Live before anything else is awaited, so a cancel from now on finds it.
    const handle = started({
      input,
      runId: row.id,
      startedAt: row.startedAt,
      conversationId: row.conversationId,
      tools: reached,
      appTools,
      messages,
      loaded: state.loaded,
      answered: state.handedBack.map((call) => ({ call, content: answers.get(call.id) ?? '' })),
      spent: { input: row.inputTokens, output: row.outputTokens },
      layers: {
        systemText: state.systemText,
        appParts: state.appParts,
        servers: state.servers,
        sampling: state.sampling,
      },
      workerId,
    });
    await bus.open(row.id);
    return handle;
  };

  /**
   * Ends a waiting run as cancelled, and says so in its events.
   *
   * @param runId - The run.
   * @param error - Why.
   * @returns The run, or undefined when it wasn't waiting.
   */
  const cancelWaiting = async (runId: string, error: string): Promise<RunRow | undefined> => {
    const [row] = await db
      .update(runs)
      .set({ status: RunStatus.Cancelled, finishedAt: now(), error, resume: null })
      .where(and(eq(runs.id, runId), eq(runs.status, RunStatus.Waiting)))
      .returning();
    if (row !== undefined) {
      await bus.open(runId);
      bus.publish(runId, { kind: RunEventKind.Done, ok: false, text: error });
      await bus.close(runId);
    }
    return row;
  };

  const cancel = async (runId: string, reason: string): Promise<RunRow | undefined> => {
    const error = reason.slice(0, settings.maxErrorLength);
    let row = await readRun(runId);
    for (let attempt = 0; attempt < CANCEL_ATTEMPTS; attempt += 1) {
      const isGoing = row !== undefined && GOING.includes(row.status);
      if (isGoing === false) {
        return row;
      }
      const going = live.get(runId);
      if (going !== undefined) {
        going.cancel.abort(error);
        await going.finished;
      } else if (row?.status === RunStatus.Waiting) {
        const cancelled = await cancelWaiting(runId, error);
        if (cancelled !== undefined) {
          return cancelled;
        }
      }
      // It ended, or a resume took it from waiting to running meanwhile: look again.
      row = await readRun(runId);
    }
    return row;
  };

  const recover = async (): Promise<number> => {
    const left = await db
      .update(runs)
      .set({ status: RunStatus.Failed, finishedAt: now(), error: RESTARTED, resume: null })
      // A run parked on a question had its loop and its tool call in the process that stopped.
      .where(
        or(
          eq(runs.status, RunStatus.Running),
          and(eq(runs.status, RunStatus.Waiting), sql`${runs.resume}->>'parked' = 'true'`),
        ),
      )
      .returning({ id: runs.id });
    for (const { id } of left) {
      await bus.open(id);
      bus.publish(id, { kind: RunEventKind.Done, ok: false, text: RESTARTED });
      await bus.close(id);
    }
    return left.length;
  };

  const prune = async (): Promise<void> => {
    const moment = now().getTime();
    const keptUntil = new Date(moment - settings.retentionDays * MS_PER_DAY);
    await db.delete(runs).where(and(notInArray(runs.status, GOING), lt(runs.finishedAt, keptUntil)));
    const keysUntil = new Date(moment - settings.idempotencyHours * MS_PER_HOUR);
    await db
      .update(runs)
      .set({ idempotencyKey: null, requestHash: null })
      .where(and(isNotNull(runs.idempotencyKey), notInArray(runs.status, GOING), lt(runs.finishedAt, keysUntil)));
    await pruneConversations(db, now());
  };

  /**
   * Runs a background job now and then.
   *
   * @param job - The job.
   * @param everyMs - How often.
   * @param what - What it does, for the log.
   */
  const every = (job: () => Promise<unknown>, everyMs: number, what: string): void => {
    const report = (error: unknown) => console.error(`[runs] ${what} failed: ${errorMessage(error)}`);
    const timer = setInterval(() => void job().catch(report), everyMs);
    timer.unref();
    timers.push(timer);
    void job().catch(report);
  };

  return {
    bus,
    workers,
    repeatOf,
    begin,
    waitingFor,
    resume,
    openConversation: (workspaceId, agent, key) => openConversation(db, workspaceId, agent, key, now()),
    recover,
    expire: async () => {
      await expireOverdue();
    },
    prune,
    cancel,
    finishing: (runId) => live.get(runId)?.finished ?? null,
    start() {
      every(prune, settings.pruneEveryHours * MS_PER_HOUR, 'pruning old runs');
      every(() => expireOverdue(), settings.expireEveryMinutes * MS_PER_MINUTE, 'expiring waiting runs');
    },
    async stop() {
      for (const timer of timers.splice(0)) {
        clearInterval(timer);
      }
      stopping.abort();
      await Promise.allSettled([...live.values()].map((going) => going.finished));
      await bus.stop();
    },
  };
}
