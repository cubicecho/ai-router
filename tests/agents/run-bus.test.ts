import { fold, type RunEvent, type RunEventInput, RunEventKind } from '@cubicecho/agent-core';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRunBus, type RunBus } from '../../server/agents/run-bus.ts';
import type { RunSettings } from '../../server/core/defaults.ts';
import { runEvents } from '../../server/db/tables/run-events.ts';
import { runs } from '../../server/db/tables/runs.ts';
import { closeTestDb, createTestDb, resetTestDb, type TestDb } from '../helpers.ts';
import { until } from './run-harness.ts';

// The run bus hands followers every event as it happens, and stores each stretch of streamed text as one row, which
// readers from any point get back with no gap and no repeat.

/** The deltas of one streamed answer. */
const DELTAS = ['The ', 'tool ', 'said: ', 'hello ', 'there'];

let db: TestDb;
let runId: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
  const [row] = await db
    .insert(runs)
    .values({ workspaceName: 'task-server', agentName: 'helper', stream: true })
    .returning();
  runId = row.id;
});

/**
 * Builds a bus that writes soon, and opens the run on it.
 *
 * @param [overrides] - Settings that differ.
 * @param [now] - The clock.
 * @returns The bus.
 */
async function openBus(overrides: Partial<RunSettings> = {}, now: () => number = Date.now): Promise<RunBus> {
  const bus = createRunBus(db, { eventFlushMs: 1, ...overrides }, now);
  await bus.open(runId);
  return bus;
}

/**
 * Says each of several events.
 *
 * @param bus - The bus.
 * @param inputs - What happened.
 * @returns The events as recorded.
 */
function sayAll(bus: RunBus, inputs: RunEventInput[]): RunEvent[] {
  return inputs.map((input) => bus.publish(runId, input));
}

/**
 * Builds the output deltas of a streamed answer.
 *
 * @param texts - The deltas.
 * @returns One event input each.
 */
function outputs(texts: string[]): RunEventInput[] {
  return texts.map((text) => ({ kind: RunEventKind.Output, text }));
}

/**
 * Reads the run's stored rows.
 *
 * @returns Oldest first.
 */
function storedRows() {
  return db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(asc(runEvents.seq));
}

describe('the run bus', () => {
  it("stores a streamed stretch as one row, under its last event's seq", async () => {
    const bus = await openBus();
    const said = sayAll(bus, [
      { kind: RunEventKind.Turn, text: 'turn 1' },
      ...outputs(DELTAS),
      { kind: RunEventKind.ToolCall, name: 'echo', id: 'a', text: '{}' },
      ...outputs(['Done', '.']),
      { kind: RunEventKind.Done, ok: true },
    ]);
    await bus.close(runId);
    const rows = await storedRows();
    expect(rows.map((row) => [row.seq, row.kind])).toEqual([
      [1, 'turn'],
      [6, 'output'],
      [7, 'tool-call'],
      [9, 'output'],
      [10, 'done'],
    ]);
    expect(rows[1]).toMatchObject({ event: { seq: 6, text: DELTAS.join('') }, textEnds: [4, 9, 15, 21, 26] });
    expect(rows[0]?.textEnds).toBeNull();
    expect(await bus.events(runId)).toEqual(fold(said));
  });

  it('gives a reader that had part of a folded stretch only the rest of it', async () => {
    const bus = await openBus();
    sayAll(bus, [
      { kind: RunEventKind.Turn, text: 'turn 1' },
      ...outputs(DELTAS),
      { kind: RunEventKind.Done, ok: true },
    ]);
    await bus.close(runId);
    // It had the turn and the first two deltas.
    const [rest, done] = await bus.events(runId, 3);
    expect(rest).toMatchObject({ seq: 6, kind: 'output', text: 'said: hello there' });
    expect(done).toMatchObject({ seq: 7, kind: 'done' });
    // It had the whole stretch, or none of it.
    expect((await bus.events(runId, 6)).map((event) => event.seq)).toEqual([7]);
    expect((await bus.events(runId, 1))[0]).toMatchObject({ seq: 6, text: DELTAS.join('') });
  });

  it('hands a follower from live deltas to stored rows with no gap and no repeat', async () => {
    const bus = await openBus();
    const watching = bus.watch(runId);
    const received: RunEvent[] = [];
    const take = async (count: number): Promise<void> => {
      for (let taken = 0; taken < count; taken += 1) {
        const next = await watching.next();
        if (next.done === false) {
          received.push(next.value);
        }
      }
    };
    const said = sayAll(bus, [{ kind: RunEventKind.Turn, text: 'turn 1' }, ...outputs(DELTAS.slice(0, 3))]);
    await take(4);
    expect(received.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    // The stretch ends and is stored while the follower is in the middle of it.
    said.push(...sayAll(bus, [...outputs(DELTAS.slice(3)), { kind: RunEventKind.ToolCall, name: 'echo', text: '{}' }]));
    await until(async () => (await storedRows()).length === 3, 'the stretch to be stored');
    said.push(...sayAll(bus, [{ kind: RunEventKind.Done, ok: true }]));
    await bus.close(runId);
    for await (const event of watching) {
      received.push(event);
    }
    expect(received.slice(4)).toEqual([
      expect.objectContaining({ seq: 6, kind: 'output', text: 'hello there' }),
      expect.objectContaining({ seq: 7, kind: 'tool-call' }),
      expect.objectContaining({ seq: 8, kind: 'done' }),
    ]);
    const text = received.filter((event) => event.kind === RunEventKind.Output).map((event) => event.text);
    expect(text.join('')).toBe(DELTAS.join(''));
    expect(fold(received)).toEqual(fold(said));
  });

  it('holds a stretch still going back, and stores it in parts that fold joins once it has waited too long', async () => {
    let clock = 0;
    const bus = await openBus({ streamHoldMs: 1_000 }, () => clock);
    sayAll(bus, outputs(DELTAS.slice(0, 2)));
    // Past a flush, a stretch that may go on is not stored yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await storedRows()).toEqual([]);
    clock = 1_000;
    sayAll(bus, outputs(DELTAS.slice(2, 3)));
    await until(async () => (await storedRows()).length === 1, 'the first part to be stored');
    sayAll(bus, [...outputs(DELTAS.slice(3)), { kind: RunEventKind.Done, ok: true }]);
    await bus.close(runId);
    const rows = await storedRows();
    expect(rows.map((row) => [row.seq, row.event.text])).toEqual([
      [3, 'The tool said: '],
      [5, 'hello there'],
      [6, ''],
    ]);
    expect(fold(await bus.events(runId))[0]).toMatchObject({ seq: 5, text: DELTAS.join('') });
  });

  it('serves rows stored before folding as they are', async () => {
    const event = (seq: number, text: string): RunEvent => ({
      runId,
      seq,
      at: seq,
      kind: RunEventKind.Output,
      text,
      name: '',
      exchange: '',
      ok: null,
      usage: null,
    });
    await db.insert(runEvents).values([
      { runId, seq: 1, kind: 'output', event: event(1, 'Hello ') },
      { runId, seq: 2, kind: 'output', event: event(2, 'there') },
    ]);
    const bus = createRunBus(db);
    expect(await bus.events(runId, 1)).toEqual([event(2, 'there')]);
  });
});
