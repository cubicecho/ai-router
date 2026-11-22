import type { RunEvent } from '@cubicecho/agent-core';
import { describe, expect, it } from 'vitest';
import { APP_CANCELLED } from '../../server/agents/run-records.ts';
import { AdminRole } from '../../server/core/admin-roles.ts';
import { CALLER_RUN, CALLER_WORKSPACE } from '../../server/core/context.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { RunStatus, runs } from '../../server/db/tables/runs.ts';
import { createClient, createWorkspaceWithKey } from '../helpers.ts';
import { dataLines, lastMessage, QUESTION, type Reply, until, useRunHarness } from './run-harness.ts';

// Cancelling a run: an app's POST /runs/<id>/cancel with its own workspace's key, and a person's cancelRun. A running
// run stops where it is and a waiting one stops waiting; either ends cancelled, and an ended run stays as it was.

const h = useRunHarness();

/** Long enough that a run still in the tool call when the test ends was never cancelled. */
const LONG_SLEEP_MS = 60_000;
/** Calls the fixture's `sleep` for a long time. */
const SLOW_SCRIPT = (): Reply => ({ call: { name: 'fix_ture__sleep', args: { ms: LONG_SLEEP_MS } } });
/** The app's tool. */
const ASK_USER = { type: 'function', function: { name: 'ask_user', parameters: { type: 'object' } } };
/** Asks the user, then answers with what the app said. */
const ASK_SCRIPT = (body: Record<string, unknown>): Reply =>
  lastMessage(body).role === 'tool' ? { content: 'thanks' } : { call: { name: 'ask_user', args: {} } };
const CANCEL_RUN = 'mutation ($id: UUID!, $reason: String) { cancelRun(id: $id, reason: $reason) { id status error } }';

/**
 * Cancels a run with a key.
 *
 * @param base - The router.
 * @param runId - The run.
 * @param [body] - The body, left out when undefined.
 * @param [secret] - The key, the harness's own by default.
 * @returns The answer.
 */
function cancel(base: string, runId: string, body?: unknown, secret = h.keySecret): Promise<Response> {
  return fetch(`${base}/runs/${runId}/cancel`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * Reads a run's stored events.
 *
 * @param base - The router.
 * @param runId - The run.
 * @returns The events.
 */
async function eventsOf(base: string, runId: string): Promise<RunEvent[]> {
  return (await (await h.get(`${base}/runs/${runId}/events`)).json()).events;
}

/**
 * Starts a run that hands `ask_user` back and waits.
 *
 * @param base - The router.
 * @returns The run's id, the answer's message and the id of the call it handed back.
 */
async function waitingRun(base: string): Promise<{ runId: string; message: unknown; callId: string }> {
  h.script = ASK_SCRIPT;
  const response = await h.complete(base, { model: 'helper', messages: [QUESTION], tools: [ASK_USER] });
  const runId = response.headers.get('x-run-id') ?? '';
  const { message } = (await response.json()).choices[0];
  return { runId, message, callId: message.tool_calls[0].id };
}

describe('POST /runs/<id>/cancel', () => {
  it('stops a running run in its tool call, ends its stream with an error, and records it cancelled', async () => {
    h.script = SLOW_SCRIPT;
    const { base } = await h.startRouter();
    const response = await h.complete(base, {
      model: 'helper',
      messages: [QUESTION],
      stream: true,
      agent_core: { progress: true },
    });
    const runId = response.headers.get('x-run-id') ?? '';
    const lines = dataLines(response);
    await until(async () => (await eventsOf(base, runId)).some((event) => event.kind === 'tool-call'), 'the call');

    const cancelled = await cancel(base, runId, { reason: 'The person pressed Stop.' });
    expect(cancelled.status).toBe(HttpStatus.Ok);
    expect(await cancelled.json()).toMatchObject({
      id: runId,
      status: RunStatus.Cancelled,
      error: 'The person pressed Stop.',
      finishedAt: expect.any(String),
    });
    const streamed = await lines;
    // The done event as a progress chunk, then the error, as any OpenAI client reads a failed stream.
    expect(streamed.at(-2)).toMatchObject({ choices: [], agent_core: { event: { kind: 'done', ok: false } } });
    expect(streamed.at(-1)).toEqual({
      error: expect.objectContaining({
        code: 'run_cancelled',
        message: 'The run was cancelled: The person pressed Stop.',
      }),
    });
    const events = await eventsOf(base, runId);
    expect(events.at(-1)).toMatchObject({ kind: 'done', ok: false, text: 'The person pressed Stop.' });
    expect(events.filter((event) => event.kind === 'done')).toHaveLength(1);
  });

  it('stops a run with an Idempotency-Key, which a disconnect would not, and a retry of the key gets the cancel', async () => {
    h.script = SLOW_SCRIPT;
    const { base } = await h.startRouter();
    const body = { model: 'helper', messages: [QUESTION] };
    const answer = h.complete(base, body, { 'idempotency-key': 'stoppable' });
    await until(() => h.received.length > 0, 'the model call');
    const [running] = await h.db.select().from(runs);
    const runId = running?.id ?? '';

    expect((await cancel(base, runId)).status).toBe(HttpStatus.Ok);
    const response = await answer;
    expect(response.status).toBe(HttpStatus.Conflict);
    expect(await response.json()).toMatchObject({
      error: { code: 'run_cancelled', message: `The run was cancelled: ${APP_CANCELLED}` },
    });
    const retry = await h.complete(base, body, { 'idempotency-key': 'stoppable' });
    expect(retry.headers.get('x-run-id')).toBe(runId);
    expect(retry.status).toBe(HttpStatus.Conflict);
  });

  it('stops a waiting run waiting, and refuses a late answer as cancelled', async () => {
    const { base } = await h.startRouter();
    const { runId, message, callId } = await waitingRun(base);

    const cancelled = await cancel(base, runId);
    expect(cancelled.status).toBe(HttpStatus.Ok);
    expect(await cancelled.json()).toMatchObject({ status: RunStatus.Cancelled, error: APP_CANCELLED });
    const row = await h.runReaches(runId, RunStatus.Cancelled);
    expect(row.resume).toBeNull();
    const events = await eventsOf(base, runId);
    expect(events.at(-1)).toMatchObject({ kind: 'done', ok: false, text: APP_CANCELLED });

    const late = await h.complete(base, {
      model: 'helper',
      messages: [QUESTION, message, { role: 'tool', tool_call_id: callId, content: 'blue' }],
      tools: [ASK_USER],
    });
    expect(late.status).toBe(HttpStatus.Conflict);
    expect(await late.json()).toMatchObject({ error: { code: 'run_cancelled' } });
  });

  it('answers an ended run unchanged, a cancelled one included', async () => {
    const { base } = await h.startRouter();
    const response = await h.complete(base, { model: 'helper', messages: [QUESTION] });
    const completedId = response.headers.get('x-run-id') ?? '';
    await response.json();
    const before = await (await h.get(`${base}/runs/${completedId}`)).json();
    const again = await cancel(base, completedId, { reason: 'Too late.' });
    expect(again.status).toBe(HttpStatus.Ok);
    expect(await again.json()).toEqual(before);
    expect(await eventsOf(base, completedId)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ ok: false })]),
    );

    const { runId } = await waitingRun(base);
    const first = await (await cancel(base, runId, { reason: 'First.' })).json();
    const second = await cancel(base, runId, { reason: 'Second.' });
    expect(await second.json()).toEqual(first);
    expect((await eventsOf(base, runId)).filter((event) => event.kind === 'done')).toHaveLength(1);
  });

  it("answers another workspace's run as missing, and leaves it going", async () => {
    const { base } = await h.startRouter();
    const { runId } = await waitingRun(base);
    const other = await createWorkspaceWithKey(h.db, 'min-agent');
    await h.snapshot.rebuild();
    const theirs = await cancel(base, runId, undefined, other.secret);
    expect(theirs.status).toBe(HttpStatus.NotFound);
    expect(await theirs.json()).toEqual({ error: 'There is no run with that id for this key.', code: 'NOT_FOUND' });
    expect((await cancel(base, '00000000-0000-4000-8000-000000000000')).status).toBe(HttpStatus.NotFound);
    expect((await h.runReaches(runId, RunStatus.Waiting)).status).toBe(RunStatus.Waiting);
  });

  it('takes a workspace key only, and refuses a reason that is not one', async () => {
    const { base } = await h.startRouter();
    const { runId } = await waitingRun(base);
    const none = await fetch(`${base}/runs/${runId}/cancel`, { method: 'POST' });
    expect(none.status).toBe(HttpStatus.Unauthorized);
    expect(await none.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    const empty = await cancel(base, runId, { reason: '  ' });
    expect(empty.status).toBe(HttpStatus.BadRequest);
    expect(await empty.json()).toMatchObject({ code: 'BAD_USER_INPUT' });
    const notJson = await fetch(`${base}/runs/${runId}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.keySecret}`, 'content-type': 'application/json' },
      body: '{',
    });
    expect(notJson.status).toBe(HttpStatus.BadRequest);
    expect(await notJson.json()).toEqual({ error: 'The body must be JSON.', code: 'BAD_USER_INPUT' });
    expect((await h.runReaches(runId, RunStatus.Waiting)).status).toBe(RunStatus.Waiting);
  });
});

describe('cancelRun', () => {
  it('lets a person cancel any run, naming them when they give no reason', async () => {
    h.script = SLOW_SCRIPT;
    const { base, runs: runService } = await h.startRouter();
    const asUser = createClient(h.db, h.user, {
      snapshot: h.snapshot,
      tools: h.tools,
      models: h.models,
      runs: runService,
    });
    const response = h.complete(base, { model: 'helper', messages: [QUESTION] });
    await until(() => h.received.length > 0, 'the model call');
    const [running] = await h.db.select().from(runs);
    const { cancelRun } = await asUser.expectOk(CANCEL_RUN, { id: running?.id });
    expect(cancelRun).toEqual({
      id: running?.id,
      status: RunStatus.Cancelled,
      error: 'Cancelled by user@example.com.',
    });
    expect((await response).status).toBe(HttpStatus.Conflict);

    const { runId } = await waitingRun(base);
    const { cancelRun: waited } = await asUser.expectOk(CANCEL_RUN, { id: runId, reason: 'Not needed.' });
    expect(waited).toMatchObject({ status: RunStatus.Cancelled, error: 'Not needed.' });
    const missing = await asUser.expectError(CANCEL_RUN, { id: '00000000-0000-4000-8000-000000000000' });
    expect(missing.code).toBe('NOT_FOUND');
  });

  it('is shut to a workspace key and to an agent run, whatever its roles', async () => {
    const { base, runs: runService } = await h.startRouter();
    const { runId } = await waitingRun(base);
    const deps = { snapshot: h.snapshot, tools: h.tools, models: h.models, runs: runService };
    const asKey = createClient(h.db, { kind: CALLER_WORKSPACE, workspaceId: h.workspaceId, keyId: 'k' }, deps);
    expect((await asKey.expectError(CANCEL_RUN, { id: runId })).code).toBe('FORBIDDEN');
    const asRun = createClient(
      h.db,
      {
        kind: CALLER_RUN,
        runId,
        workspaceId: h.workspaceId,
        agentId: h.agentId,
        roles: Object.values(AdminRole),
        depth: 1,
      },
      deps,
    );
    expect((await asRun.expectError(CANCEL_RUN, { id: runId })).code).toBe('FORBIDDEN');
    expect((await h.runReaches(runId, RunStatus.Waiting)).status).toBe(RunStatus.Waiting);
  });
});
