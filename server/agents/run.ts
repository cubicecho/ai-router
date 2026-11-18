import {
  type AgentLoopOptions,
  type CatalogServer,
  createRuntime,
  failedRun,
  type RunEventInput,
  RunEventKind,
  type Runtime,
  ToolDiscovery,
  type ToolDispatch,
} from '@cubicecho/agent-core';
import { and, eq, isNotNull, lt, ne } from 'drizzle-orm';
import { RUN_DEFAULTS, type RunSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '../core/wire.ts';
import type { DB } from '../db/client.ts';
import type { SnapshotAgent, SnapshotHost, SnapshotWorkspace } from '../db/snapshot.ts';
import { type RunAnswer, type RunRow, RunStatus, runs } from '../db/tables/runs.ts';
import type { ToolServices } from '../tools/api.ts';
import { isToolError, toolResultContent, toolResultText } from '../tools/tool-result.ts';
import type { RunConfig } from './layers.ts';
import { reachOf } from './reach.ts';
import type { RunRequest } from './request.ts';
import { createRunBus, type RunBus } from './run-bus.ts';
import { type RunTool, runToolNames } from './tool-names.ts';

/** One tool definition, as the loop sends it. */
type ToolDefinition = NonNullable<AgentLoopOptions['tools']>[number];

/** What joins the text of two turns in a run's answer. */
const TURN_JOIN = '\n\n';
/** OpenAI's finish reason for an answer cut off at its ceiling. */
const FINISH_LENGTH = 'length';
/** OpenAI's finish reason for an answer the model ended. */
const FINISH_STOP = 'stop';
/** What a run that a restart cut short says. */
const RESTARTED = 'The router restarted while the run was going.';

/** A request's `Idempotency-Key`, and the hash of the body it came with. */
export interface Idempotency {
  key: string;
  hash: string;
}

/** What a run starts from: who asked, which agent, and the checked, resolved request. */
export interface RunInput {
  workspace: SnapshotWorkspace;
  /** An agent with a live revision, which this workspace may run. */
  agent: SnapshotAgent;
  request: RunRequest;
  config: RunConfig;
  idempotency: Idempotency | null;
}

/** A run as it ended, or as it stands for one still going elsewhere. */
export interface FinishedRun {
  runId: string;
  agentName: string;
  status: RunStatus;
  startedAt: Date;
  /** Null unless it completed. */
  answer: RunAnswer | null;
  inputTokens: number;
  outputTokens: number;
  /** Why it failed or was cancelled. */
  error: string | null;
}

/** A run this request started. */
export interface StartedRun {
  kind: 'started';
  runId: string;
  startedAt: Date;
  /**
   * Runs it to its end.
   *
   * @param onText - Hears the answer's text as it arrives, a blank line between turns.
   * @param signal - The app's connection: aborting it cancels the run.
   * @returns How it ended. Never rejects: a failure is a failed run.
   */
  execute(onText: (text: string) => void, signal: AbortSignal): Promise<FinishedRun>;
}

/** A run an earlier request with the same `Idempotency-Key` started. */
export interface RepeatedRun {
  kind: 'repeated';
  runId: string;
  /** Whether this request's body is the one the key was first sent with. */
  matches: boolean;
  /**
   * Waits for the run to end, if it is still going here, and reads it.
   *
   * @returns How it ended.
   */
  finished(): Promise<FinishedRun>;
}

/** Starts, records and answers agent runs. */
export interface RunService {
  /** Where live runs' events are. */
  bus: RunBus;
  /**
   * Finds the run a workspace's `Idempotency-Key` already started.
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
   */
  begin(input: RunInput): Promise<StartedRun | RepeatedRun>;
  /**
   * Marks the runs a stopped router left `running` as failed. Call it at boot, before the agents endpoint opens.
   *
   * @returns How many there were.
   */
  recover(): Promise<number>;
  /** Deletes finished runs past their retention, and frees keys past the idempotency window. */
  prune(): Promise<void>;
  /** Starts the timer that prunes. */
  start(): void;
  /** Stops the timer, fails the runs still going, and waits for them to be recorded. */
  stop(): Promise<void>;
}

/** What the run service talks to. */
export interface RunServiceDeps {
  db: DB;
  snapshot: SnapshotHost;
  tools: ToolServices;
  /**
   * agent-core's caches and event bus for the runs.
   * @defaultValue a runtime of their own
   */
  runtime?: Runtime;
  /** Settings that differ from `RUN_DEFAULTS`. */
  overrides?: Partial<RunSettings>;
  /** The clock retention is judged by. */
  now?: () => Date;
}

/** A tool the run reaches, with what the model is told about it. */
interface ReachedTool extends RunTool {
  description: string;
  parameters: Record<string, unknown>;
}

/** The tools a run reaches, named for its model. */
interface RunTools {
  definitions: ToolDefinition[];
  /** By function name. */
  names: Map<string, ReachedTool>;
  catalog: CatalogServer[];
}

/**
 * Reads a stored run as an ended one.
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
 * Builds the run service.
 *
 * @param deps - The database, the snapshot, the tools area, and stand-ins for tests.
 * @returns The service, with its timer not yet started.
 */
export function createRunService({
  db,
  snapshot,
  tools,
  runtime = createRuntime(),
  overrides = {},
  now = () => new Date(),
}: RunServiceDeps): RunService {
  const settings = { ...RUN_DEFAULTS, ...overrides };
  const bus = createRunBus(runtime);
  /** Runs going in this process, by id: what a repeated key waits on. */
  const live = new Map<string, Promise<FinishedRun>>();
  /** Fails every run still going when the router stops. */
  const stopping = new AbortController();
  let timer: NodeJS.Timeout | null = null;

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
        if (going !== undefined) {
          return going;
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
   * Lists the tools of every server the run reaches, as its workspace's instances, and names them for the model.
   *
   * @param runId - The run, whose events say what was left out.
   * @param config - The resolved agent, for its servers and discovery.
   * @param workspaceId - Whose instances to use.
   * @returns The tools. A server that can't start or list is left out and said so, never failing the run.
   */
  const reachedTools = async (runId: string, config: RunConfig, workspaceId: string): Promise<RunTools> => {
    const notice = (text: string): void => {
      bus.publish(runId, { kind: RunEventKind.Notice, text });
    };
    const reach = reachOf(config.servers, snapshot.current());
    for (const name of reach.missing) {
      notice(`server "${name}" is not on this router or is turned off; it is left out.`);
    }
    const listed = await Promise.all(
      reach.servers.map(async (server): Promise<ReachedTool[]> => {
        try {
          const served = await tools.listTools(server.id, workspaceId);
          return served.map((tool) => ({
            serverId: server.id,
            serverName: server.name,
            tool: tool.name,
            description: tool.description ?? tool.title ?? '',
            parameters: isRecord(tool.inputSchema) ? tool.inputSchema : { type: 'object' },
          }));
        } catch (error) {
          console.warn(`[runs] run ${runId} leaves server ${server.name} out: ${errorMessage(error)}`);
          notice(`server "${server.name}" could not list its tools, so they are left out: ${errorMessage(error)}`);
          return [];
        }
      }),
    );
    const { names, dropped } = runToolNames(listed.flat());
    for (const tool of dropped) {
      notice(`tool "${tool.tool}" of server "${tool.serverName}" is left out: its name clashes with another.`);
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
    return { definitions, names, catalog: [...byServer.values()] };
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
        })
        .where(and(eq(runs.id, finished.runId), eq(runs.status, RunStatus.Running)));
    } catch (error) {
      console.error(`[runs] could not record how run ${finished.runId} ended: ${errorMessage(error)}`);
    }
  };

  /**
   * Runs one agent to its answer.
   *
   * @param input - The run.
   * @param row - Its row, just written.
   * @param onText - Hears the answer's text.
   * @param signal - The app's connection.
   * @returns How it ended.
   */
  const run = async (
    input: RunInput,
    row: RunRow,
    onText: (text: string) => void,
    signal: AbortSignal,
  ): Promise<FinishedRun> => {
    const { workspace, agent, request, config } = input;
    const runId = row.id;
    const deadline = AbortSignal.timeout(settings.timeoutMinutes * MS_PER_MINUTE);
    const runSignal = AbortSignal.any([signal, deadline, stopping.signal]);
    let answer = '';
    let isNewTurn = false;
    const onEvent = (event: RunEventInput): void => {
      bus.publish(runId, event);
      if (event.kind === RunEventKind.Turn) {
        isNewTurn = answer !== '';
      }
      const text = event.text ?? '';
      if (event.kind === RunEventKind.Output && text !== '') {
        const delta = isNewTurn ? `${TURN_JOIN}${text}` : text;
        isNewTurn = false;
        answer += delta;
        onText(delta);
      }
    };
    const ended = (status: RunStatus, usage: { promptTokens: number; completionTokens: number } | undefined) => ({
      runId,
      agentName: agent.name,
      status,
      startedAt: row.startedAt,
      inputTokens: usage?.promptTokens ?? 0,
      outputTokens: usage?.completionTokens ?? 0,
    });
    let finished: FinishedRun;
    try {
      const reached = await reachedTools(runId, config, workspace.id);
      const dispatch: ToolDispatch = async (call, callSignal) => {
        const target = reached.names.get(call.name);
        if (target === undefined) {
          throw new Error(`This run has no tool named "${call.name}".`);
        }
        const result = await tools.callTool(target.serverId, workspace.id, target.tool, call.args, {
          agentId: agent.id,
          agentName: agent.name,
          runId,
          signal: callSignal ?? runSignal,
        });
        if (isToolError(result)) {
          throw new Error(toolResultText(result));
        }
        return toolResultContent(result);
      };
      const isEager = config.toolDiscovery === ToolDiscovery.Eager;
      const result = await runtime.runAgentLoop({
        config,
        system: config.systemPrompt,
        messages: request.messages,
        tools: reached.definitions,
        ...(isEager ? {} : { catalog: reached.catalog }),
        dispatch,
        signal: runSignal,
        session: runId,
        onEvent,
      });
      const finishReason = result.turn.finishReason === FINISH_LENGTH ? FINISH_LENGTH : FINISH_STOP;
      finished = {
        ...ended(RunStatus.Completed, result.usage),
        answer: { content: answer, finishReason },
        error: null,
      };
    } catch (error) {
      const usage = failedRun(error)?.usage;
      if (signal.aborted) {
        finished = { ...ended(RunStatus.Cancelled, usage), answer: null, error: 'The app disconnected.' };
      } else if (deadline.aborted) {
        const error = `The run took longer than ${settings.timeoutMinutes} minutes.`;
        finished = { ...ended(RunStatus.Failed, usage), answer: null, error };
      } else if (stopping.signal.aborted) {
        finished = { ...ended(RunStatus.Failed, usage), answer: null, error: 'The router stopped while it ran.' };
      } else {
        finished = { ...ended(RunStatus.Failed, usage), answer: null, error: errorMessage(error) };
      }
    }
    const isCompleted = finished.status === RunStatus.Completed;
    bus.publish(runId, { kind: RunEventKind.Done, ok: isCompleted, text: finished.error ?? '' });
    await record(finished);
    return finished;
  };

  const begin = async (input: RunInput): Promise<StartedRun | RepeatedRun> => {
    const { workspace, agent, request, idempotency } = input;
    const [row] = await db
      .insert(runs)
      .values({
        workspaceId: workspace.id,
        workspaceName: workspace.slug,
        agentId: agent.id,
        agentName: agent.name,
        revisionId: agent.liveRevisionId,
        user: request.user,
        stream: request.stream,
        idempotencyKey: idempotency?.key ?? null,
        requestHash: idempotency?.hash ?? null,
      })
      .onConflictDoNothing({ target: [runs.workspaceId, runs.idempotencyKey] })
      .returning();
    if (row === undefined) {
      // Another request with the same key got there first.
      const repeat = idempotency === null ? null : await repeatOf(workspace.id, idempotency);
      if (repeat === null) {
        throw new Error('The run was not recorded, and no run holds its key.');
      }
      return repeat;
    }
    let settle: (finished: FinishedRun) => void = () => {};
    live.set(
      row.id,
      new Promise<FinishedRun>((resolve) => {
        settle = resolve;
      }),
    );
    return {
      kind: 'started',
      runId: row.id,
      startedAt: row.startedAt,
      execute: async (onText, signal) => {
        const finished = await run(input, row, onText, signal);
        settle(finished);
        live.delete(row.id);
        return finished;
      },
    };
  };

  const recover = async (): Promise<number> => {
    const left = await db
      .update(runs)
      .set({ status: RunStatus.Failed, finishedAt: now(), error: RESTARTED })
      .where(eq(runs.status, RunStatus.Running))
      .returning({ id: runs.id });
    return left.length;
  };

  const prune = async (): Promise<void> => {
    const moment = now().getTime();
    const keptUntil = new Date(moment - settings.retentionDays * MS_PER_DAY);
    await db.delete(runs).where(and(ne(runs.status, RunStatus.Running), lt(runs.finishedAt, keptUntil)));
    const keysUntil = new Date(moment - settings.idempotencyHours * MS_PER_HOUR);
    await db
      .update(runs)
      .set({ idempotencyKey: null, requestHash: null })
      .where(and(isNotNull(runs.idempotencyKey), ne(runs.status, RunStatus.Running), lt(runs.finishedAt, keysUntil)));
  };

  return {
    bus,
    repeatOf,
    begin,
    recover,
    prune,
    start() {
      const report = (error: unknown) => console.error(`[runs] pruning old runs failed: ${errorMessage(error)}`);
      timer = setInterval(() => void prune().catch(report), settings.pruneEveryHours * MS_PER_HOUR);
      timer.unref();
      void prune().catch(report);
    },
    async stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      stopping.abort();
      await Promise.allSettled([...live.values()]);
    },
  };
}
