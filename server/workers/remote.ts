import { WORKER_DEFAULTS, type WorkerSettings } from '../core/defaults.ts';
import type { RunAssignment, RunOutcome, RunPorts } from '../runner/assignment.ts';
import { ChannelMessageType } from '../runner/protocol.ts';
import type { WorkerRegistry } from './registry.ts';
import type { RunWorker } from './worker.ts';

/**
 * What a run on a worker that went away ends with.
 *
 * @param name - The worker's name.
 * @returns The run's error.
 */
export const wentAway = (name: string): string => `worker ${name} went away`;

/**
 * What a run ends with when its worker dials in again without it: the worker restarted, and lost the run.
 *
 * @param name - The worker's name.
 * @returns The run's error.
 */
export const restartedWithout = (name: string): string => `worker ${name} restarted, and lost the run`;
/** What a run stopped without a reason is told. */
const STOPPED = 'The run was stopped.';

/** A stretch of a run executing on a remote worker now: what its doors answer with. */
export interface RemoteRun {
  workerId: string;
  /** The stretch, as the worker was sent it: its targets say which router tools it may call. */
  assignment: RunAssignment;
  /** The router's side of the stretch. */
  ports: RunPorts;
  /**
   * Ends the stretch with the worker's outcome. Does nothing once it has ended.
   *
   * @param outcome - How the worker says the loop ended.
   */
  finish(outcome: RunOutcome): void;
}

/** The runs on remote workers, and the workers they run on. */
export interface RemoteWorkers {
  /** Which workers are online, and their channels. */
  registry: WorkerRegistry;
  /** The settings in force: `WORKER_DEFAULTS` with the overrides. */
  settings: Readonly<WorkerSettings>;
  /**
   * The worker that sends runs to one remote worker.
   *
   * @param workerId - The remote worker.
   * @returns It, as the run service executes stretches on it.
   */
  worker(workerId: string): RunWorker;
  /**
   * Finds a stretch executing on a worker now.
   *
   * @param workerId - The worker asking.
   * @param runId - The run it names.
   * @returns The stretch, or undefined when that run is not executing on that worker.
   */
  running(workerId: string, runId: string): RemoteRun | undefined;
  /**
   * Counts the stretches executing on a worker now.
   *
   * @param workerId - The worker.
   * @returns How many.
   */
  runsOn(workerId: string): number;
  /**
   * Hears which runs a worker holds, as its hello says, and ends at once each run sent it on an earlier channel that
   * it no longer holds. A run sent on the channel the hello came on is kept: the worker may not have read it yet.
   *
   * @param workerId - The worker.
   * @param runIds - The runs it holds, or undefined from a worker that doesn't say, whose runs are kept.
   */
  hold(workerId: string, runIds: readonly string[] | undefined): void;
}

/** A stretch in flight, with the timers that may end it without the worker. */
interface Pending extends RemoteRun {
  /** Ends it when the worker stays away past the grace, or the cancel goes unanswered. */
  timer: NodeJS.Timeout | null;
  /** Which of the worker's channels it was sent on, counted from 1 since the router started. */
  channel: number;
}

/**
 * Builds the remote workers' side of the router: assigning stretches down their channels, and ending them on `finish`,
 * on a cancel the worker doesn't answer, or when the worker stays away.
 *
 * @param registry - The online workers.
 * @param [overrides] - Settings that differ from `WORKER_DEFAULTS`.
 * @param [nameOf] - A worker's name, as a run's error says it. Its id when not given.
 * @returns The remote workers.
 *
 * @remarks
 * A worker that comes back within `reconnectGraceMs` keeps its runs and is sent nothing again: it carries on with what
 * it had and drops what the router no longer names. Its hello says which runs it holds, and `hold` ends the others.
 */
export function createRemoteWorkers(
  registry: WorkerRegistry,
  overrides: Partial<WorkerSettings> = {},
  nameOf: (workerId: string) => string = (workerId) => workerId,
): RemoteWorkers {
  const settings = { ...WORKER_DEFAULTS, ...overrides };
  const pending = new Map<string, Pending>();
  const made = new Map<string, RunWorker>();
  /** Each worker's newest channel, counted from 1. */
  const channels = new Map<string, number>();
  const channelOf = (workerId: string): number => channels.get(workerId) ?? 0;
  const fail = (run: Pending, error: string): void => run.finish({ ok: false, error, usage: undefined });

  const endLater = (run: Pending, afterMs: number, error: string): void => {
    if (run.timer === null) {
      run.timer = setTimeout(() => fail(run, error), afterMs);
    }
  };

  registry.watch((workerId, online) => {
    if (online) {
      channels.set(workerId, channelOf(workerId) + 1);
    }
    for (const run of pending.values()) {
      if (run.workerId !== workerId) {
        continue;
      }
      if (online && run.timer !== null && run.ports.signal.aborted === false) {
        clearTimeout(run.timer);
        run.timer = null;
      } else if (online === false) {
        endLater(run, settings.reconnectGraceMs, wentAway(nameOf(workerId)));
      }
    }
  });

  const execute = (workerId: string, assignment: RunAssignment, ports: RunPorts): Promise<RunOutcome> =>
    new Promise((resolve) => {
      const { runId } = assignment;
      const { signal } = ports;
      const onAbort = (): void => {
        const reason = signal.reason === undefined ? STOPPED : String(signal.reason);
        registry.send(workerId, { type: ChannelMessageType.Cancel, runId, reason });
        if (run.timer !== null) {
          clearTimeout(run.timer);
          run.timer = null;
        }
        endLater(run, settings.cancelGraceMs, reason);
      };
      const run: Pending = {
        workerId,
        assignment,
        ports,
        timer: null,
        channel: channelOf(workerId),
        finish(outcome) {
          if (pending.get(runId) !== run) {
            return;
          }
          pending.delete(runId);
          if (run.timer !== null) {
            clearTimeout(run.timer);
          }
          signal.removeEventListener('abort', onAbort);
          resolve(outcome);
        },
      };
      pending.set(runId, run);
      const isSent = registry.send(workerId, { type: ChannelMessageType.Assign, assignment });
      if (isSent === false) {
        fail(run, wentAway(nameOf(workerId)));
        return;
      }
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });

  return {
    registry,
    settings,
    worker(workerId) {
      const known = made.get(workerId);
      if (known !== undefined) {
        return known;
      }
      const worker: RunWorker = { execute: (assignment, ports) => execute(workerId, assignment, ports) };
      made.set(workerId, worker);
      return worker;
    },
    running(workerId, runId) {
      const run = pending.get(runId);
      return run?.workerId === workerId ? run : undefined;
    },
    runsOn: (workerId) => [...pending.values()].filter((run) => run.workerId === workerId).length,
    hold(workerId, runIds) {
      if (runIds === undefined) {
        return;
      }
      const held = new Set(runIds);
      const current = channelOf(workerId);
      for (const [runId, run] of pending) {
        const isLost = run.workerId === workerId && run.channel < current && held.has(runId) === false;
        if (isLost) {
          fail(run, restartedWithout(nameOf(workerId)));
        }
      }
    },
  };
}
