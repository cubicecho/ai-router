import { fold, type RunEvent, type RunEventInput, RunEventKind } from '@cubicecho/agent-core';
import { and, asc, eq, gt, inArray, max } from 'drizzle-orm';
import { RUN_DEFAULTS, type RunSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import type { DB } from '../db/client.ts';
import { type NewRunEventRow, type RunEventRow, runEvents } from '../db/tables/run-events.ts';
import { RunStatus, runs } from '../db/tables/runs.ts';

/** The statuses of a run that may still say something. */
const GOING: RunStatus[] = [RunStatus.Running, RunStatus.Waiting];
/** The kinds whose stretches `fold` joins: streamed text, one event per delta. */
const STREAMED: ReadonlySet<string> = new Set([RunEventKind.Thinking, RunEventKind.Output]);

/** A row to store, and how many events it holds. */
interface StoredRow {
  row: NewRunEventRow;
  count: number;
}

/**
 * Where each event's text ends once the texts are joined.
 *
 * @param events - The events of one stretch.
 * @returns One offset per event, in UTF-16 code units, as JavaScript slices.
 */
function textEndsOf(events: RunEvent[]): number[] {
  const ends: number[] = [];
  for (const event of events) {
    ends.push((ends.at(-1) ?? 0) + event.text.length);
  }
  return ends;
}

/**
 * Joins events into the rows that store them, with agent-core's `fold`.
 *
 * @param runId - The run.
 * @param events - Events with no gap in their `seq`s, oldest first.
 * @returns One row per block, each with how many of the events it holds.
 */
function rowsOf(runId: string, events: RunEvent[]): StoredRow[] {
  let start = 0;
  return fold(events).map((block) => {
    const firstSeq = events[start]?.seq ?? block.seq;
    const count = block.seq - firstSeq + 1;
    const held = events.slice(start, start + count);
    start += count;
    const textEnds = count > 1 ? textEndsOf(held) : null;
    return { count, row: { runId, seq: block.seq, kind: block.kind, event: block, textEnds } };
  });
}

/**
 * Whether two events are in one stretch that `fold` would join.
 *
 * @param event - An event.
 * @param other - The event after it.
 * @returns true when both are streamed text of the same kind, in the same exchange.
 */
function isSameStretch(event: RunEvent, other: RunEvent): boolean {
  return STREAMED.has(event.kind) && event.kind === other.kind && event.exchange === other.exchange;
}

/**
 * How many of a run's pending events may be stored now.
 *
 * @param pending - The events not yet stored, oldest first.
 * @param holdMs - How long a stretch still going may wait.
 * @param moment - Now, in epoch milliseconds.
 * @returns All of them, except a stretch of streamed text they end with that has waited less than `holdMs`, which
 * may go on and is stored whole once it ends.
 */
function settledCount(pending: RunEvent[], holdMs: number, moment: number): number {
  const last = pending.at(-1);
  const isStreaming = last !== undefined && STREAMED.has(last.kind);
  if (isStreaming === false) {
    return pending.length;
  }
  const start = pending.findLastIndex((event) => isSameStretch(event, last) === false) + 1;
  const begunAt = pending[start]?.at ?? moment;
  const isHeldTooLong = moment - begunAt >= holdMs;
  return isHeldTooLong ? pending.length : start;
}

/**
 * A stored row as a reader that has every event up to `afterSeq` should get it.
 *
 * @param row - The row.
 * @param afterSeq - The last event the reader has.
 * @returns The event. For a joined stretch the reader has part of, only the text after that part.
 */
function restOf({ event, textEnds }: Pick<RunEventRow, 'event' | 'textEnds'>, afterSeq: number): RunEvent {
  const ends = textEnds ?? [];
  const firstSeq = event.seq - ends.length + 1;
  const had = afterSeq - firstSeq;
  const isPartlyRead = had >= 0 && had < ends.length - 1;
  if (isPartlyRead === false) {
    return event;
  }
  return { ...event, text: event.text.slice(ends.at(had) ?? 0) };
}

/**
 * A run's events: numbered, stored in `run_events`, and handed to whoever follows the run. Each is agent-core's
 * `RunEvent`, unchanged, except that the stored ones are folded.
 *
 * @remarks
 * The router numbers the events itself, carrying on from the last stored one, because a run that waits for an app
 * can outlive agent-core's in-memory bus, and the process too, and `seq` must never start again. Followers get every
 * event from memory. The table gets each stretch of streamed `thinking` or `output` as one row, under its last
 * event's `seq`, so a streamed answer is a row and not one per token.
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
   * A run's events after a point, stored and not yet stored alike: stored ones folded, the rest as they came.
   *
   * @param runId - The run.
   * @param [afterSeq] - The last event the reader has. 0 reads from the start. Inside a folded stretch, the reader
   * gets the rest of its text.
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
  const { eventFlushMs, streamHoldMs, eventBatchSize } = { ...RUN_DEFAULTS, ...overrides };
  const open = new Map<string, OpenRun>();
  const followers = new Map<string, Set<() => void>>();
  let timer: NodeJS.Timeout | null = null;

  /**
   * Stores what a run has pending, folded, after any write already going.
   *
   * @param runId - The run.
   * @param held - Its state.
   * @param isClosing - Whether the run has said all it will for now, so a stretch it ends with is over too.
   * @returns When the write is done. It never rejects: a failed write stays pending for the next.
   */
  const write = (runId: string, held: OpenRun, isClosing: boolean): Promise<void> => {
    held.writing = held.writing.then(async () => {
      const settled = isClosing ? held.pending.length : settledCount(held.pending, streamHoldMs, now());
      const rows = rowsOf(runId, held.pending.slice(0, settled));
      try {
        for (let start = 0; start < rows.length; start += eventBatchSize) {
          const batch = rows.slice(start, start + eventBatchSize);
          await db
            .insert(runEvents)
            .values(batch.map(({ row }) => row))
            .onConflictDoNothing();
          held.pending.splice(
            0,
            batch.reduce((sum, { count }) => sum + count, 0),
          );
        }
      } catch (error) {
        console.error(`[runs] could not store run ${runId}'s events: ${errorMessage(error)}`);
      }
    });
    return held.writing;
  };

  const flushAll = async (): Promise<void> => {
    timer = null;
    const waiting = [...open].filter(([, held]) => held.pending.length > 0);
    await Promise.all(waiting.map(([runId, held]) => write(runId, held, false)));
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
      .select({ event: runEvents.event, textEnds: runEvents.textEnds })
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
      .orderBy(asc(runEvents.seq));
    // The first row may be a stretch the reader had part of, live, before it was stored.
    const stored = (limit === undefined ? await query : await query.limit(limit)).map((row) => restOf(row, afterSeq));
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
    await write(runId, held, true);
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
