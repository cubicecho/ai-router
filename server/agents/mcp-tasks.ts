import type { RunEvent } from '@cubicecho/agent-core';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  type CallToolResult,
  CancelTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  GetTaskRequestSchema,
  ListTasksRequestSchema,
  McpError,
  ErrorCode as McpErrorCode,
  type ProgressToken,
  RELATED_TASK_META_KEY,
  type Task,
} from '@modelcontextprotocol/sdk/types.js';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { WorkspaceCaller } from '../core/context.ts';
import { RUN_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { MS_PER_DAY } from '../core/wire.ts';
import type { DB } from '../db/client.ts';
import { type RunRow, RunStatus, runs } from '../db/tables/runs.ts';
import type { RunService } from './run.ts';
import { APP_CANCELLED } from './run-records.ts';

/**
 * The `_meta` key a progress notification carries the run's event under: agent-core's `RunEvent`, unchanged, as a
 * `/v1` progress chunk carries it.
 */
export const RUN_EVENT_META_KEY = 'cubicecho.com/run-event';

/** What `/mcp` says it can do with tasks: list and cancel them, and run a tool call as one. */
export const TASKS_CAPABILITY = { list: {}, cancel: {}, requests: { tools: { call: {} } } };

/** A task's status, by its run's. A run waits only for a `/v1` app's tool answers, which MCP calls input. */
const TASK_STATUS: Readonly<Record<RunStatus, Task['status']>> = {
  [RunStatus.Running]: 'working',
  [RunStatus.Waiting]: 'input_required',
  [RunStatus.Completed]: 'completed',
  [RunStatus.Failed]: 'failed',
  [RunStatus.Expired]: 'failed',
  [RunStatus.Cancelled]: 'cancelled',
};

/** Why a waiting run's task is waiting. */
const WAITING_MESSAGE = 'The run waits for the app to answer the tool calls it handed back on /v1.';

/** A task id, before it is looked up: a run's. */
const taskIdSchema = z.uuid();

/** The run fields a task is read from. */
export type TaskSource = Pick<RunRow, 'id' | 'status' | 'startedAt' | 'finishedAt' | 'waitingSince' | 'error'>;

/** A finished run, as a tool call's result reads it. */
export type CallSource = Pick<RunRow, 'status' | 'answer' | 'error'> & { runId: string };

/**
 * Writes a run as its task.
 *
 * @param run - The run.
 * @returns The task: the run's id, its status, kept as long as the run's record, and checked every
 * `RUN_DEFAULTS.taskPollIntervalMs`.
 */
export function taskOf(run: TaskSource): Task {
  const lastUpdated = run.finishedAt ?? run.waitingSince ?? run.startedAt;
  const statusMessage = run.status === RunStatus.Waiting ? WAITING_MESSAGE : run.error;
  return {
    taskId: run.id,
    status: TASK_STATUS[run.status],
    ttl: RUN_DEFAULTS.retentionDays * MS_PER_DAY,
    createdAt: run.startedAt.toISOString(),
    lastUpdatedAt: lastUpdated.toISOString(),
    pollInterval: RUN_DEFAULTS.taskPollIntervalMs,
    ...(statusMessage === null ? {} : { statusMessage }),
  };
}

/**
 * Writes how a run ended as its tool call's result.
 *
 * @param run - The finished run.
 * @returns The agent's text, with the run's id in `_meta`; or, for a run that didn't complete, why, marked as an
 * error so the client's model reads it as one.
 */
export function callResultOf({ runId, status, answer, error }: CallSource): CallToolResult {
  if (status !== RunStatus.Completed) {
    const what = status === RunStatus.Cancelled ? 'was cancelled' : 'failed';
    return { content: [{ type: 'text', text: `The run ${what}: ${error ?? ''} Run ${runId}.` }], isError: true };
  }
  const text = answer?.content ?? '';
  return {
    content: [{ type: 'text', text: text === '' ? '(The agent wrote nothing.)' : text }],
    _meta: { runId },
  };
}

/**
 * Whether a run has come to an end it won't leave.
 *
 * @param status - The run's status.
 * @returns true when it completed, failed, expired or was cancelled.
 */
function isEnded(status: RunStatus): boolean {
  return status !== RunStatus.Running && status !== RunStatus.Waiting;
}

/** What a request's task handlers talk to. */
export interface TaskHandlerDeps {
  db: DB;
  runs: RunService;
  /** The key the request came with: it reaches only its own workspace's runs. */
  caller: WorkspaceCaller;
  /** Aborted when the request's connection closes. */
  left: AbortSignal;
  /** The progress token each task's own call asked for, by run, while the run goes. */
  tokens: ReadonlyMap<string, ProgressToken>;
  /** Says what a run's event is, as a progress message, or null for one that isn't a step. */
  describe: (event: RunEvent) => string | null;
}

/**
 * Answers `tasks/get`, `tasks/result`, `tasks/list` and `tasks/cancel` from the runs table: a task is a run of the
 * key's workspace, and its id is the run's.
 *
 * @param server - One request's MCP server, which must say it has the tasks capability.
 * @param deps - The database, the run service, the caller and the connection.
 *
 * @remarks
 * The SDK's own handlers keep tasks in a `TaskStore` scoped by MCP session and hand `tasks/result` a queue it polls.
 * `/mcp` has no session, and a run already has a durable record and a live event stream, so these read those instead:
 * `tasks/result` follows the run's events as they happen.
 */
export function serveTasks(server: Server, { db, runs: runService, caller, left, tokens, describe }: TaskHandlerDeps) {
  /**
   * Finds a run of the caller's workspace.
   *
   * @param taskId - The task's id.
   * @returns The run.
   * @throws {@link McpError} When there is no such run for this key: another workspace's is as missing as one that
   * never was.
   */
  const ownRun = async (taskId: string): Promise<RunRow> => {
    const isId = taskIdSchema.safeParse(taskId).success;
    const [row] = isId
      ? await db
          .select()
          .from(runs)
          .where(and(eq(runs.id, taskId), eq(runs.workspaceId, caller.workspaceId)))
      : [];
    if (row === undefined) {
      throw new McpError(McpErrorCode.InvalidParams, `There is no task ${taskId} for this key.`);
    }
    return row;
  };

  server.setRequestHandler(GetTaskRequestSchema, async (request) => taskOf(await ownRun(request.params.taskId)));

  server.setRequestHandler(GetTaskPayloadRequestSchema, async (request, extra) => {
    const { taskId } = request.params;
    const run = await ownRun(taskId);
    const progressToken = request.params._meta?.progressToken ?? tokens.get(run.id);
    const signal = AbortSignal.any([extra.signal, left]);
    for await (const event of runService.bus.watch(run.id, { signal })) {
      if (progressToken === undefined) {
        continue;
      }
      const message = describe(event);
      await extra
        .sendNotification({
          method: 'notifications/progress',
          params: {
            progressToken,
            progress: event.seq,
            ...(message === null ? {} : { message }),
            _meta: { [RELATED_TASK_META_KEY]: { taskId }, [RUN_EVENT_META_KEY]: event },
          },
        })
        .catch((error: unknown) => console.warn(`[mcp] could not send a task's progress: ${errorMessage(error)}`));
    }
    signal.throwIfAborted();
    // Its `done` is said just before its end is recorded.
    await runService.finishing(run.id);
    const ended = await ownRun(taskId);
    if (ended.status === RunStatus.Waiting) {
      // A /v1 run that handed calls back has no result yet, and only the app that started it can answer them.
      throw new McpError(McpErrorCode.InvalidRequest, `Task ${taskId}: ${WAITING_MESSAGE}`);
    }
    const result = callResultOf({ ...ended, runId: ended.id });
    return { ...result, _meta: { ...result._meta, [RELATED_TASK_META_KEY]: { taskId } } };
  });

  server.setRequestHandler(ListTasksRequestSchema, async (request) => {
    const offset = Number(request.params?.cursor ?? 0);
    const isCursor = Number.isInteger(offset) && offset >= 0;
    if (isCursor === false) {
      throw new McpError(McpErrorCode.InvalidParams, 'cursor: send the nextCursor a listing gave.');
    }
    const pageSize = RUN_DEFAULTS.runPageSize;
    const rows = await db
      .select()
      .from(runs)
      .where(eq(runs.workspaceId, caller.workspaceId))
      .orderBy(desc(runs.startedAt), desc(runs.id))
      .limit(pageSize + 1)
      .offset(offset);
    const hasMore = rows.length > pageSize;
    return {
      tasks: rows.slice(0, pageSize).map(taskOf),
      ...(hasMore ? { nextCursor: String(offset + pageSize) } : {}),
    };
  });

  server.setRequestHandler(CancelTaskRequestSchema, async (request) => {
    const run = await ownRun(request.params.taskId);
    if (isEnded(run.status)) {
      throw new McpError(McpErrorCode.InvalidParams, `Task ${run.id} has ended (${TASK_STATUS[run.status]}).`);
    }
    const cancelled = await runService.cancel(run.id, APP_CANCELLED);
    return taskOf(cancelled ?? run);
  });
}
