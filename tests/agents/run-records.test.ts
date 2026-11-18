import type { RunEvent } from '@cubicecho/agent-core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createRunService } from '../../server/agents/run.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { runEvents } from '../../server/db/tables/run-events.ts';
import { RunStatus, runs } from '../../server/db/tables/runs.ts';
import { createSessionToken, createTestAuth, createWorkspaceWithKey } from '../helpers.ts';
import { dataLines, ECHO, lastMessage, QUESTION, until, useRunHarness } from './run-harness.ts';

// A run's record and its events, stored in order and read back by the key that ran it: as JSON, as a live event
// stream, and in GraphQL.

const h = useRunHarness();

/** Calls the fixture's `sleep`, so a run is still going while the test reads it. */
const SLOW_SCRIPT = (body: Record<string, unknown>) =>
  lastMessage(body).role === 'tool' ? { content: 'awake' } : { call: { name: 'fix_ture__sleep', args: { ms: 300 } } };

/**
 * Checks that events are one run's, in order, from 1, with no gap and no repeat, ending in its `done`.
 *
 * @param events - The events.
 * @param runId - The run.
 */
function expectWhole(events: RunEvent[], runId: string): void {
  expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index + 1));
  expect(events.every((event) => event.runId === runId)).toBe(true);
  expect(events.at(-1)).toMatchObject({ kind: 'done', ok: true });
}

describe('GET /runs/<id>', () => {
  it("answers a run's agent, revision, status, timings, usage and error, for its own workspace's key only", async () => {
    const { base } = await h.startRouter();
    const response = await h.complete(base, { model: 'helper', messages: [QUESTION], user: 'household-a' });
    const runId = response.headers.get('x-run-id') ?? '';
    await response.json();
    const record = await h.get(`${base}/runs/${runId}`);
    expect(record.status).toBe(HttpStatus.Ok);
    const body = await record.json();
    expect(body).toEqual({
      id: runId,
      agent: 'helper',
      agentId: h.agentId,
      revisionId: h.revisionId,
      workspace: 'task-server',
      status: RunStatus.Completed,
      user: 'household-a',
      startedAt: expect.any(String),
      finishedAt: expect.any(String),
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      error: null,
    });
    expect(Date.parse(body.finishedAt)).toBeGreaterThanOrEqual(Date.parse(body.startedAt));

    const other = await createWorkspaceWithKey(h.db, 'min-agent');
    await h.snapshot.rebuild();
    const theirs = await h.get(`${base}/runs/${runId}`, { authorization: `Bearer ${other.secret}` });
    expect(theirs.status).toBe(HttpStatus.NotFound);
    expect(await theirs.json()).toEqual({ error: 'There is no run with that id for this key.', code: 'NOT_FOUND' });
    const theirEvents = await h.get(`${base}/runs/${runId}/events`, { authorization: `Bearer ${other.secret}` });
    expect(theirEvents.status).toBe(HttpStatus.NotFound);
    expect((await h.get(`${base}/runs/not-a-run`)).status).toBe(HttpStatus.NotFound);
  });

  it('takes workspace keys only', async () => {
    const { base } = await h.startRouter();
    const none = await fetch(`${base}/runs/00000000-0000-4000-8000-000000000000`);
    expect(none.status).toBe(HttpStatus.Unauthorized);
    expect(await none.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    const session = await createSessionToken(createTestAuth(h.db), h.user.userId);
    const asPerson = await fetch(`${base}/runs/00000000-0000-4000-8000-000000000000`, {
      headers: { authorization: `Bearer ${session}` },
    });
    expect(asPerson.status).toBe(HttpStatus.Unauthorized);
  });
});

describe('GET /runs/<id>/events', () => {
  it("answers every event of a run, stored in order in run_events, as agent-core's RunEvent", async () => {
    const { base } = await h.startRouter();
    const response = await h.complete(base, { model: 'helper', messages: [QUESTION] });
    const runId = response.headers.get('x-run-id') ?? '';
    await response.json();
    const answer = await h.get(`${base}/runs/${runId}/events`);
    expect(answer.status).toBe(HttpStatus.Ok);
    const { runId: named, events } = (await answer.json()) as { runId: string; events: RunEvent[] };
    expect(named).toBe(runId);
    expectWhole(events, runId);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call', name: ECHO, id: 'call_1' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-result', name: ECHO, ok: true }));
    const stored = await h.db.select().from(runEvents).where(eq(runEvents.runId, runId)).orderBy(runEvents.seq);
    expect(stored.map((row) => row.event)).toEqual(events);
    expect(stored.map((row) => row.kind)).toEqual(events.map((event) => event.kind));
    const later = await (await h.get(`${base}/runs/${runId}/events?after=3`)).json();
    expect(later.events.map((event: RunEvent) => event.seq)).toEqual(events.slice(3).map((event) => event.seq));
    expect((await h.get(`${base}/runs/${runId}/events?after=-1`)).status).toBe(HttpStatus.BadRequest);
  });

  it('follows a live run as an event stream: past events first, then live ones, with no gap and no repeat', async () => {
    h.script = SLOW_SCRIPT;
    const { base } = await h.startRouter();
    const pending = h.complete(base, { model: 'helper', messages: [QUESTION], stream: true });
    const response = await pending;
    const runId = response.headers.get('x-run-id') ?? '';
    // Join once the tool is running, so some events are behind the follower and some ahead of it.
    await until(() => h.received.length > 0, 'the model to be asked');
    const followed = await h.get(`${base}/runs/${runId}/events`, { accept: 'text/event-stream' });
    expect(followed.headers.get('content-type')).toContain('text/event-stream');
    const [streamed, answered] = await Promise.all([followed.text(), dataLines(response)]);
    expect(answered.at(-1)).toBe('[DONE]');
    const events = streamed
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as RunEvent);
    expectWhole(events, runId);
    expect(streamed).toContain(`id: ${events.at(-1)?.seq}\n`);
    // A client that reconnects says where it was, and gets only what came after.
    const resumed = await h.get(`${base}/runs/${runId}/events`, {
      accept: 'text/event-stream',
      'last-event-id': String(events.length - 1),
    });
    const rest = await dataLines(resumed);
    expect(rest).toEqual([events.at(-1)]);
  });

  it('deletes a run’s events with the run, and gives a run a restart cut short its done', async () => {
    const values = { workspaceId: h.workspaceId, workspaceName: 'task-server', agentName: 'helper', stream: false };
    const long = new Date(Date.now() - 40 * 86_400_000);
    const [old] = await h.db
      .insert(runs)
      .values({ ...values, status: RunStatus.Completed, startedAt: long, finishedAt: long })
      .returning();
    const [left] = await h.db
      .insert(runs)
      .values({ ...values, status: RunStatus.Running })
      .returning();
    const oldId = old?.id ?? '';
    const leftId = left?.id ?? '';
    const event = { runId: oldId, seq: 1, kind: 'done', event: { runId: oldId, seq: 1, kind: 'done' } as RunEvent };
    await h.db.insert(runEvents).values(event);
    await h.db.insert(runEvents).values({ ...event, runId: leftId, event: { ...event.event, runId: leftId } });
    const runService = createRunService({ db: h.db, snapshot: h.snapshot, tools: h.tools });
    await runService.recover();
    expect((await runService.bus.events(leftId)).at(-1)).toMatchObject({
      seq: 2,
      kind: 'done',
      ok: false,
      text: 'The router restarted while the run was going.',
    });
    await runService.prune();
    expect(await h.db.select().from(runEvents).where(eq(runEvents.runId, oldId))).toEqual([]);
    await runService.stop();
  });
});

describe('GraphQL', () => {
  it("serves a run's stored events on Run.events, folded if asked, and replays them in runEvents", async () => {
    const { base } = await h.startRouter();
    const response = await h.complete(base, { model: 'helper', messages: [QUESTION] });
    const runId = response.headers.get('x-run-id') ?? '';
    await response.json();
    const { run } = await h.asUser.expectOk(
      `query ($id: UUID!) {
        run(where: { id: { eq: $id } }) {
          id
          all: events { seq kind name text ok }
          page: events(afterSeq: 2, limit: 2) { seq }
          folded: events(folded: true) { kind text }
        }
      }`,
      { id: runId },
    );
    expect(run.all[0]).toMatchObject({ seq: 1 });
    expect(run.all.at(-1)).toMatchObject({ kind: 'done', ok: true });
    expect(run.page).toEqual([{ seq: 3 }, { seq: 4 }]);
    const outputs = run.folded.filter((event: { kind: string }) => event.kind === 'output');
    expect(outputs.map((event: { text: string }) => event.text)).toEqual(['The tool said: hello there']);
    const refused = await h.asUser.expectError(
      `query ($id: UUID!) { run(where: { id: { eq: $id } }) { id events(limit: 0) { seq } } }`,
      { id: runId },
    );
    expect(refused.code).toBe('BAD_USER_INPUT');

    // The run ended before anyone subscribed, and the subscription still tells it whole.
    const session = await createSessionToken(createTestAuth(h.db), h.user.userId);
    const followed = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${session}` },
      body: JSON.stringify({ query: `subscription { runEvents(runId: "${runId}", afterSeq: 1) { seq kind } }` }),
    });
    const events = (await followed.text())
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line.includes('runEvents'))
      .map((line) => JSON.parse(line.slice('data: '.length)).data.runEvents);
    expect(events.map((event) => event.seq)).toEqual(run.all.slice(1).map((event: { seq: number }) => event.seq));
  });
});
