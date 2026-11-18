import { type RunEvent, type RunEventInput, RunEventKind } from '@cubicecho/agent-core';
import { and, asc, eq, gt, inArray, max } from 'drizzle-orm';
import { RUN_DEFAULTS, type RunSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import type { DB } from '../db/client.ts';
import { runEvents } from '../db/tables/run-events.ts';
import { RunStatus, runs } from '../db/tables/runs.ts';

/** The statuses of a run that may still say something. */
const GOING: RunStatus[] = [RunStatus.Running, RunStatus.Waiting];

/**
 * A run's events: numbered, stored in `run_events`, and handed to whoever follows the run. Each is agent-core's
 * `RunEvent`, unchanged.
 *
 * @remarks
 * The router numbers the events itself, carrying on from the last stored one, because a run that waits for an app
 * can outlive agent-core's in-memory bus, and the process too, and `seq` must never start again.
 */
export interface RunBus {
  /**
   * Starts numbering a run's events after the ones already stored. Call it before the run says anything.
   *
   * @param runId - The run.
   */
  open(runId: string): Promise<void>;
  /**
   * Records one event and wakes the run's followers.
   *
   * @param runId - An open run.
   * @param input - What happened. The bus numbers and stamps it.
   * @returns The event as recorded.
   * @throws {Error} For a run that isn't open, which is a bug in the caller.
   */
  publish(runId: string, input: RunEventInput): RunEvent;
  /**
   * Stores what an open run has said and stops numbering it, for a run that ended or waits.
   *
   * @param runId - The run.
   */
  close(runId: string): Promise<void>;
  /**
   * A run's events after a point, stored and not yet stored alike.
   *
   * @param runId - The run.
   * @param [afterSeq] - The last event the reader has. 0 reads from the start.
   * @param [limit] - The most to read.
   * @returns Oldest first.
   */
  events(runId: string, afterSeq?: number, limit?: number): Promise<RunEvent[]>;
  /**
   * Follows a run: what it has said, then what it says next, until its `done`, with no gap and no repeat.
   *
   * @param runId - A run that exists.
   * @param [options] - Where to start, and a signal that stops following.
   * @returns The events. They end after `done`, or at once for an ended run that never said one.
   */
  watch(runId: string, options?: { afterSeq?: number; signal?: AbortSignal }): AsyncGenerator<RunEvent>;
  /** Stores everything not yet stored, and forgets every open run. */
  stop(): Promise<void>;
}

/** A run whose events this process is numbering. */
interface OpenRun {
  /** The last `seq` handed out. */
  seq: number;
  /** Events not yet stored, oldest first. An event leaves only once it is stored. */
  pending: RunEvent[];
  /** The write in progress, so writes go in order. */
  writing: Promise<void>;
}

/**
 * Builds the run bus.
 *
 * @param db - Where the events are stored.
 * @param [overrides] - Settings that differ from `RUN_DEFAULTS`.
 * @param [now] - The clock events are stamped by, in epoch milliseconds.
 * @returns The bus.
 */
export function createRunBus(db: DB, overrides: Partial<RunSettings> = {}, now: () => number = Date.now): RunBus {
  const { eventFlushMs, eventBatchSize } = { ...RUN_DEFAULTS, ...overrides };
  const open = new Map<string, OpenRun>();
  const followers = new Map<string, Set<() => void>>();
  let timer: NodeJS.Timeout | null = null;

  /**
   * Stores what a run has pending, after any write already going.
   *
   * @param runId - The run.
   * @param held - Its state.
   * @returns When the write is done. It never rejects: a failed write stays pending for the next.
   */
  const write = (runId: string, held: OpenRun): Promise<void> => {
    held.writing = held.writing.then(async () => {
      const batch = held.pending.slice();
      try {
        for (let start = 0; start < batch.length; start += eventBatchSize) {
          const rows = batch
            .slice(start, start + eventBatchSize)
            .map((event) => ({ runId, seq: event.seq, kind: event.kind, event }));
          await db.insert(runEvents).values(rows).onConflictDoNothing();
        }
        held.pending.splice(0, batch.length);
      } catch (error) {
        console.error(`[runs] could not store run ${runId}'s events: ${errorMessage(error)}`);
      }
    });
    return held.writing;
  };

  const flushAll = async (): Promise<void> => {
    timer = null;
    const waiting = [...open].filter(([, held]) => held.pending.length > 0);
    await Promise.all(waiting.map(([runId, held]) => write(runId, held)));
  };

  const schedule = (): void => {
    if (timer === null) {
      timer = setTimeout(() => void flushAll(), eventFlushMs);
      timer.unref();
    }
  };

  const read = async (runId: string, afterSeq: number, limit?: number): Promise<RunEvent[]> => {
    // Taken before the stored rows are read: an event leaves `pending` only once it is stored, so it is in one or
    // the other.
    const held = (open.get(runId)?.pending ?? []).filter((event) => event.seq > afterSeq);
    const isAllHeld = held[0]?.seq === afterSeq + 1;
    if (isAllHeld) {
      return limit === undefined ? held : held.slice(0, limit);
    }
    const query = db
      .select({ event: runEvents.event })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
      .orderBy(asc(runEvents.seq));
    const stored = (limit === undefined ? await query : await query.limit(limit)).map((row) => row.event);
    const lastStored = stored.at(-1)?.seq ?? afterSeq;
    const merged = [...stored, ...held.filter((event) => event.seq > lastStored)];
    return limit === undefined ? merged : merged.slice(0, limit);
  };

  const hasEnded = async (runId: string): Promise<boolean> => {
    if (open.has(runId)) {
      return false;
    }
    const [row] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.id, runId), inArray(runs.status, GOING)));
    return row === undefined;
  };

  const close = async (runId: string): Promise<void> => {
    const held = open.get(runId);
    if (held === undefined) {
      return;
    }
    await write(runId, held);
    if (held.pending.length > 0) {
      console.error(`[runs] run ${runId} loses ${held.pending.length} events that could not be stored.`);
    }
    open.delete(runId);
  };

  return {
    async open(runId) {
      if (open.has(runId)) {
        return;
      }
      const [row] = await db
        .select({ last: max(runEvents.seq) })
        .from(runEvents)
        .where(eq(runEvents.runId, runId));
      open.set(runId, { seq: row?.last ?? 0, pending: [], writing: Promise.resolve() });
    },
    publish(runId, input) {
      const held = open.get(runId);
      if (held === undefined) {
        throw new Error(`Run ${runId} said something while its events were not open.`);
      }
      held.seq += 1;
      // agent-core's defaults for an unset field, as its own bus stamps them, then the run and its place.
      const event: RunEvent = {
        at: now(),
        text: '',
        name: '',
        exchange: '',
        ok: null,
        usage: null,
        ...input,
        runId,
        seq: held.seq,
      };
      held.pending.push(event);
      schedule();
      for (const wake of followers.get(runId) ?? []) {
        wake();
      }
      return event;
    },
    close,
    events: (runId, afterSeq = 0, limit) => read(runId, afterSeq, limit),
    async *watch(runId, { afterSeq = 0, signal } = {}) {
      let last = afterSeq;
      let isSignalled = false;
      let wake: (() => void) | null = null;
      const follower = (): void => {
        isSignalled = true;
        wake?.();
      };
      const watching = followers.get(runId) ?? new Set();
      watching.add(follower);
      followers.set(runId, watching);
      const onAbort = (): void => wake?.();
      const isStopped = (): boolean => signal?.aborted === true;
      signal?.addEventListener('abort', onAbort);
      try {
        while (isStopped() === false) {
          isSignalled = false;
          const events = await read(runId, last);
          for (const event of events) {
            yield event;
            last = event.seq;
            if (event.kind === RunEventKind.Done) {
              return;
            }
          }
          const isQuiet = events.length === 0 && isSignalled === false;
          if (isQuiet === false) {
            continue;
          }
          // An ended run that never said `done`, such as one from before events were stored, has nothing to add.
          const isOver = await hasEnded(runId);
          if (isOver && isSignalled === false) {
            return;
          }
          const isAsleep = isSignalled === false && isStopped() === false;
          if (isAsleep) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
          }
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        watching.delete(follower);
        if (watching.size === 0) {
          followers.delete(runId);
        }
      }
    },
    async stop() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await Promise.all([...open.keys()].map(close));
    },
  };
}
