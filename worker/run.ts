import { setTimeout as delay } from 'node:timers/promises';
import { type RunEventInput, type Runtime, stamp } from '@cubicecho/agent-core';
import { z } from 'zod';
import { WORKER_DEFAULTS, type WorkerSettings } from '../server/core/defaults.ts';
import { errorMessage } from '../server/core/errors.ts';
import { HttpStatus, MODELS_BASE_URL } from '../server/core/wire.ts';
import type {
  FailedOutcome,
  RunAssignment,
  RunOutcome,
  RunPorts,
  ToolCallOptions,
} from '../server/runner/assignment.ts';
import { executeRun } from '../server/runner/execute.ts';
import {
  type RouterToolAnswer,
  RUN_NOT_FOUND,
  runDoorPath,
  WORKERS_PATH,
  WorkerDoor,
} from '../server/runner/protocol.ts';
import { WORKER_PROGRAM_DEFAULTS, type WorkerProgramSettings } from './defaults.ts';
import type { LocalServers } from './servers.ts';

/** Why a run ended when a door answered 404: the router no longer runs it on this worker. */
export const RUN_DROPPED = 'the router dropped this run';
/** How an assignment past `maxRunsAtOnce` is finished. */
export const WORKER_BUSY = 'this worker is busy';
/** How a stopping worker's runs, and an assignment it gets while stopping, are finished. */
export const WORKER_STOPPING = 'the worker is stopping';

/** What a request to the router's doors carries. */
const JSON_TYPE = 'application/json';
/** The methods that send no body. */
const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** What the tools door answers. */
const routerToolAnswerSchema: z.ZodType<RouterToolAnswer> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), text: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/** A run door's own 404, as the router writes it: `{ error, code }`. */
const runNotFoundSchema = z.object({ code: z.literal(RUN_NOT_FOUND) });

/**
 * Whether a 404 is a run door's own, saying the router no longer runs the run here, rather than one the router's
 * models answered.
 *
 * @param response - A copy of the 404, whose body this reads.
 * @returns Whether its body carries the `run_not_found` code.
 */
async function isRunNotFound(response: Response): Promise<boolean> {
  const body: unknown = await response.json().catch(() => undefined);
  return runNotFoundSchema.safeParse(body).success;
}

/** What the run host is built with. */
export interface RunHostOptions {
  /** The router's address, with no trailing slash. */
  url: string;
  /** The worker key, which every door takes. */
  key: string;
  /** The worker's own servers. Absent when it has none. */
  local?: LocalServers;
  /** agent-core's runtime, whose loop the runs use. */
  runtime: Pick<Runtime, 'runAgentLoop'>;
  /**
   * Makes the requests.
   *
   * @defaultValue `globalThis.fetch`
   */
  fetch?: typeof globalThis.fetch;
}

/** The runs this worker holds. */
export interface RunHost {
  /**
   * Starts a stretch of a run. One past the cap, a run already held, or one that comes while stopping, is finished at
   * once as failed, or ignored when held.
   *
   * @param assignment - The stretch.
   */
  assign(assignment: RunAssignment): void;
  /**
   * Stops a run: its loop, model and tool calls. It still finishes, as failed with the reason.
   *
   * @param runId - The run.
   * @param reason - Why, as its outcome says.
   */
  cancel(runId: string, reason: string): void;
  /**
   * Counts the runs going now.
   *
   * @returns How many.
   */
  held(): number;
  /**
   * Names the runs going now, as the hello says them.
   *
   * @returns Their ids.
   */
  ids(): string[];
  /**
   * Stops every run, finishes each as failed, and refuses new ones.
   *
   * @returns Resolves once each has finished, or the stop deadline passed.
   */
  stop(): Promise<void>;
}

/** One run the worker holds. */
interface HeldRun {
  controller: AbortController;
  /** Why it was stopped, when a cancel or the worker stopping did it. */
  stoppedFor: string | undefined;
  /** Whether a door answered 404, so nothing more is sent for it. */
  dropped: boolean;
  /** Resolves once its finish is sent, or given up. */
  done: Promise<void>;
}

/** A run's queued events, sent in order, one request at a time. */
interface EventQueue {
  push(event: RunEventInput): void;
  /** Sends every event queued. Resolves once each is sent or given up. */
  drain(): Promise<void>;
}

/**
 * Starts the runs the router assigns this worker, each through its own doors.
 *
 * @param options - The router, the key, the local servers and the runtime.
 * @param [overrides] - Settings that replace `WORKER_DEFAULTS` and `WORKER_PROGRAM_DEFAULTS`.
 * @returns The host.
 */
export function createRunHost(
  options: RunHostOptions,
  overrides: Partial<WorkerSettings & WorkerProgramSettings> = {},
): RunHost {
  const { url, key, local, runtime, fetch = globalThis.fetch } = options;
  const settings = { ...WORKER_DEFAULTS, ...WORKER_PROGRAM_DEFAULTS, ...overrides };
  const authorization = `Bearer ${key}`;
  const runs = new Map<string, HeldRun>();
  let isStopping = false;

  const doorUrl = (runId: string, door: WorkerDoor): string => `${url}${WORKERS_PATH}${runDoorPath(runId, door)}`;

  const post = (runId: string, door: WorkerDoor, body: unknown, signal?: AbortSignal): Promise<Response> =>
    fetch(doorUrl(runId, door), {
      method: 'POST',
      headers: { authorization, 'content-type': JSON_TYPE },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });

  /** Posts, sending again after a network error, `sendAttempts` times in all. */
  const postWithRetry = async (runId: string, door: WorkerDoor, body: unknown): Promise<Response> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await post(runId, door, body);
      } catch (error) {
        const isLastAttempt = attempt >= settings.sendAttempts;
        if (isLastAttempt) {
          throw error;
        }
        await delay(settings.sendRetryMs);
      }
    }
  };

  const finish = async (runId: string, outcome: RunOutcome): Promise<void> => {
    try {
      const response = await postWithRetry(runId, WorkerDoor.Finish, outcome);
      await response.body?.cancel().catch(() => undefined);
      if (response.status === HttpStatus.NotFound) {
        console.warn(`[worker] run ${runId} finished, but ${RUN_DROPPED}`);
      } else if (response.ok === false) {
        console.error(`[worker] the router refused run ${runId}'s finish: ${response.status}`);
      }
    } catch (error) {
      console.error(`[worker] could not send run ${runId}'s finish: ${errorMessage(error)}`);
    }
  };

  const failAtOnce = (runId: string, error: string): void => {
    const outcome: FailedOutcome = { ok: false, error, usage: undefined };
    void finish(runId, outcome);
  };

  const eventQueue = (runId: string, held: HeldRun, drop: () => void): EventQueue => {
    let pending: RunEventInput[] = [];
    let timer: NodeJS.Timeout | undefined;
    let sending = Promise.resolve();
    const sendAll = async (): Promise<void> => {
      while (pending.length > 0) {
        if (held.dropped) {
          pending = [];
          return;
        }
        const events = pending.splice(0, settings.eventBatchSize);
        try {
          const response = await postWithRetry(runId, WorkerDoor.Events, { events });
          await response.body?.cancel().catch(() => undefined);
          if (response.status === HttpStatus.NotFound) {
            drop();
          } else if (response.ok === false) {
            console.error(`[worker] the router refused ${events.length} of run ${runId}'s events: ${response.status}`);
          }
        } catch (error) {
          console.error(`[worker] could not send ${events.length} of run ${runId}'s events: ${errorMessage(error)}`);
        }
      }
    };
    const flush = (): Promise<void> => {
      clearTimeout(timer);
      timer = undefined;
      sending = sending.then(sendAll);
      return sending;
    };
    return {
      push: (event) => {
        pending.push(event);
        const isFull = pending.length >= settings.eventBatchSize;
        if (isFull) {
          void flush();
        } else if (timer === undefined) {
          timer = setTimeout(() => void flush(), settings.eventFlushMs);
        }
      },
      drain: flush,
    };
  };

  const portsFor = (runId: string, held: HeldRun, events: EventQueue, drop: () => void): RunPorts => {
    const runSignal = held.controller.signal;
    /** Reads a door's answer: a 404 means the router dropped the run, which ends it here too. */
    const checked = async (response: Response): Promise<Response> => {
      if (response.status === HttpStatus.NotFound) {
        await response.body?.cancel().catch(() => undefined);
        drop();
        throw new Error(RUN_DROPPED);
      }
      return response;
    };
    const modelFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const isRouters = request.url === MODELS_BASE_URL || request.url.startsWith(`${MODELS_BASE_URL}/`);
      if (isRouters === false) {
        throw new TypeError(`A run on this worker may call only the router's models, not ${request.url}.`);
      }
      const headers = new Headers(request.headers);
      headers.set('authorization', authorization);
      const hasBody = BODYLESS_METHODS.has(request.method) === false;
      const response = await fetch(`${doorUrl(runId, WorkerDoor.Model)}${request.url.slice(MODELS_BASE_URL.length)}`, {
        method: request.method,
        headers,
        ...(hasBody ? { body: await request.arrayBuffer() } : {}),
        signal: AbortSignal.any([request.signal, runSignal]),
      });
      // The router's models answer 404 themselves, for a model or path they don't have, and that 404 is the loop's to
      // read. Only the door's own 404, coded `run_not_found`, means the router dropped the run.
      const isDropped = response.status === HttpStatus.NotFound && (await isRunNotFound(response.clone()));
      return isDropped ? checked(response) : response;
    };
    return {
      modelFetch,
      callRouterTool: async (server, tool, args, { call, signal }) => {
        const response = await checked(await post(runId, WorkerDoor.Tools, { server, tool, args, call }, signal));
        if (response.ok === false) {
          const text = await response.text().catch(() => '');
          throw new Error(`The router's tools door answered ${response.status}: ${text}`.trim());
        }
        const answer = routerToolAnswerSchema.parse(await response.json());
        if (answer.ok === false) {
          throw new Error(answer.error);
        }
        return answer.text;
      },
      ...(local === undefined
        ? {}
        : {
            callLocalTool: (server: string, tool: string, args: Record<string, unknown>, { signal }: ToolCallOptions) =>
              local.callTool(server, tool, args, signal),
          }),
      publish: (event) => {
        events.push(event);
        // The router numbers the events; the runner never reads this one.
        return stamp(event, runId, 0, Date.now());
      },
      signal: runSignal,
    };
  };

  const run = async (assignment: RunAssignment, held: HeldRun): Promise<void> => {
    const { runId } = assignment;
    const drop = (): void => {
      if (held.dropped) {
        return;
      }
      held.dropped = true;
      console.warn(`[worker] stopping run ${runId}: ${RUN_DROPPED}`);
      held.controller.abort(new Error(RUN_DROPPED));
    };
    const events = eventQueue(runId, held, drop);
    const outcome = await executeRun(assignment, portsFor(runId, held, events, drop), runtime);
    await events.drain();
    if (held.dropped) {
      return;
    }
    const { stoppedFor } = held;
    const reported: RunOutcome =
      stoppedFor === undefined ? outcome : { ok: false, error: stoppedFor, usage: outcome.usage };
    console.log(`[worker] run ${runId} ${reported.ok ? 'finished' : `failed: ${reported.error}`}`);
    await finish(runId, reported);
  };

  return {
    assign: (assignment) => {
      const { runId } = assignment;
      if (runs.has(runId)) {
        console.warn(`[worker] ignoring a second assignment of run ${runId}, which is still going here`);
        return;
      }
      if (isStopping) {
        failAtOnce(runId, WORKER_STOPPING);
        return;
      }
      const isFull = runs.size >= settings.maxRunsAtOnce;
      if (isFull) {
        console.warn(`[worker] turning down run ${runId}: ${settings.maxRunsAtOnce} runs are going already`);
        failAtOnce(runId, WORKER_BUSY);
        return;
      }
      const held: HeldRun = {
        controller: new AbortController(),
        stoppedFor: undefined,
        dropped: false,
        done: Promise.resolve(),
      };
      runs.set(runId, held);
      console.log(`[worker] run ${runId} started: agent ${assignment.config.id}`);
      held.done = run(assignment, held)
        .catch((error) => console.error(`[worker] run ${runId} failed here: ${errorMessage(error)}`))
        .finally(() => runs.delete(runId));
    },
    cancel: (runId, reason) => {
      const held = runs.get(runId);
      if (held === undefined) {
        return;
      }
      held.stoppedFor ??= reason;
      held.controller.abort(new Error(reason));
    },
    held: () => runs.size,
    ids: () => [...runs.keys()],
    stop: async () => {
      isStopping = true;
      const going = [...runs.values()];
      for (const held of going) {
        held.stoppedFor ??= WORKER_STOPPING;
        held.controller.abort(new Error(WORKER_STOPPING));
      }
      const deadline = delay(settings.stopDeadlineMs, undefined, { ref: false });
      await Promise.race([Promise.all(going.map((held) => held.done)), deadline]);
    },
  };
}
