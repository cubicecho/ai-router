import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { titleOf } from '../../server/agents/run-sessions.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { RunStatus, runs } from '../../server/db/tables/runs.ts';
import { createClient, createWorkspaceWithKey, workspaceCaller } from '../helpers.ts';
import { CREATE_AGENT, lastMessage, QUESTION, useRunHarness } from './run-harness.ts';

// A session is the runs one workspace's app sent under one key, `X-Conversation-Id` or else `X-Session-Id`, whichever
// agents ran them. It is a label: the runs screen groups by it, and an app lists a session's runs at /runs.

const h = useRunHarness();

/** A one-pixel PNG, for a message with only an image. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const SESSIONS = `query ($workspaceId: UUID, $agentName: String, $limit: Int, $offset: Int) {
  runSessions(workspaceId: $workspaceId, agentName: $agentName, limit: $limit, offset: $offset) {
    count
    sessions {
      key title workspaceId workspaceName agentNames runCount openRunCount failedRunCount cancelledRunCount lastStatus
      lastError startedAt lastStartedAt lastFinishedAt runMs inputTokens outputTokens
    }
  }
}`;

/**
 * Runs an agent to its answer.
 *
 * @param base - The router.
 * @param model - The agent.
 * @param headers - The session headers, and a key in place of the harness's.
 * @returns The run's id.
 */
async function runOnce(base: string, model: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await h.complete(base, { model, messages: [QUESTION] }, headers);
  expect(response.status).toBe(HttpStatus.Ok);
  await response.json();
  return response.headers.get('x-run-id') ?? '';
}

/**
 * Adds an agent the harness's workspace may run.
 *
 * @param id - Its name.
 */
async function addAgent(id: string): Promise<void> {
  const { createAgent } = await h.asUser.expectOk(CREATE_AGENT, {
    document: { spec: 'cubicecho.agent/2', id, model: { model: 'fake/m1' }, tools: { servers: [] } },
  });
  await h.offer(h.workspaceId, createAgent.id, []);
  await h.snapshot.rebuild();
}

describe('a run’s session', () => {
  it('is the conversation’s key, else X-Session-Id, else none', async () => {
    h.script = (body) => ({ content: `heard ${lastMessage(body).content}` });
    const { base } = await h.startRouter();
    await runOnce(base, 'helper', { 'x-session-id': 'chat-1' });
    await runOnce(base, 'helper', { 'x-conversation-id': 'talk', 'x-session-id': 'chat-1' });
    await runOnce(base, 'helper');
    const rows = await h.db.select({ sessionKey: runs.sessionKey }).from(runs).orderBy(runs.startedAt);
    expect(rows.map((row) => row.sessionKey)).toEqual(['chat-1', 'talk', null]);
  });

  it('refuses an X-Session-Id that is empty, too long or has spaces, before the run starts', async () => {
    const { base } = await h.startRouter();
    for (const value of ['has space', 'x'.repeat(256)]) {
      const response = await h.complete(base, { model: 'helper', messages: [QUESTION] }, { 'x-session-id': value });
      expect(response.status).toBe(HttpStatus.BadRequest);
      expect((await response.json()).error).toMatchObject({ param: 'X-Session-Id' });
    }
    expect(await h.db.select().from(runs)).toEqual([]);
  });
});

describe('runSessions', () => {
  it("groups one workspace's runs by key across agents, the latest session first, and filters and pages them", async () => {
    h.script = () => ({ content: 'done' });
    const { base } = await h.startRouter();
    await addAgent('titler');
    const other = await createWorkspaceWithKey(h.db, 'min-agent');
    await h.offer(other.workspaceId, h.agentId);
    await h.snapshot.rebuild();

    await runOnce(base, 'helper', { 'x-session-id': 'chat-1' });
    await runOnce(base, 'titler', { 'x-session-id': 'chat-1' });
    await runOnce(base, 'helper', { 'x-session-id': 'chat-1' });
    await runOnce(base, 'helper', { 'x-session-id': 'chat-2' });
    await runOnce(base, 'helper');
    // The same key from another workspace is another session.
    await runOnce(base, 'helper', { 'x-session-id': 'chat-1', authorization: `Bearer ${other.secret}` });

    const { runSessions } = await h.asUser.expectOk(SESSIONS);
    expect(runSessions.count).toBe(3);
    expect(runSessions.sessions.map((s: { key: string; workspaceName: string }) => [s.workspaceName, s.key])).toEqual([
      ['min-agent', 'chat-1'],
      ['task-server', 'chat-2'],
      ['task-server', 'chat-1'],
    ]);
    const chat = runSessions.sessions[2];
    expect(chat).toMatchObject({
      workspaceId: h.workspaceId,
      agentNames: ['helper', 'titler'],
      runCount: 3,
      openRunCount: 0,
      // Each run's one model call is 10 in and 5 out.
      inputTokens: 30,
      outputTokens: 15,
    });
    expect(new Date(chat.lastStartedAt).getTime()).toBeGreaterThan(new Date(chat.startedAt).getTime());

    const ours = await h.asUser.expectOk(SESSIONS, { workspaceId: h.workspaceId, limit: 1, offset: 1 });
    expect(ours.runSessions.count).toBe(2);
    expect(ours.runSessions.sessions.map((s: { key: string }) => s.key)).toEqual(['chat-1']);
    const titled = await h.asUser.expectOk(SESSIONS, { agentName: 'titler' });
    expect(titled.runSessions.sessions.map((s: { key: string }) => s.key)).toEqual(['chat-1']);

    const refused = await h.asUser.expectError(SESSIONS, { limit: 0 });
    expect(refused.code).toBe('BAD_USER_INPUT');
  });

  it('names a session by its first user message, and says how it went and how long it took', async () => {
    h.script = () => ({ content: 'done' });
    const { base } = await h.startRouter();
    const ask = async (messages: unknown[]) => {
      const response = await h.complete(base, { model: 'helper', messages }, { 'x-session-id': 'trip' });
      expect(response.status).toBe(HttpStatus.Ok);
      await response.json();
      return response.headers.get('x-run-id') ?? '';
    };
    const opening = await ask([
      { role: 'system', content: 'You plan trips.' },
      { role: 'user', content: '   ' },
      { role: 'user', content: '  Plan   a\n\nweekend   in Lisbon  ' },
    ]);
    const failed = await ask([{ role: 'user', content: 'and book it' }]);
    const cancelled = await ask([{ role: 'user', content: 'never mind' }]);
    await h.db.update(runs).set({ status: RunStatus.Failed, error: 'The model went away.' }).where(eq(runs.id, failed));
    await h.db.update(runs).set({ status: RunStatus.Cancelled, error: 'Cancelled.' }).where(eq(runs.id, cancelled));

    const ended = (await h.asUser.expectOk(SESSIONS)).runSessions.sessions[0];
    expect(ended).toMatchObject({
      key: 'trip',
      title: 'Plan a weekend in Lisbon',
      runCount: 3,
      openRunCount: 0,
      failedRunCount: 1,
      cancelledRunCount: 1,
      lastStatus: RunStatus.Cancelled,
      lastError: 'The model went away.',
    });
    const rows = await h.db.select().from(runs).orderBy(runs.startedAt);
    const took = rows.reduce((sum, row) => sum + ((row.finishedAt?.getTime() ?? 0) - row.startedAt.getTime()), 0);
    expect(ended.runMs).toBeCloseTo(took, 0);
    const lastEnd = Math.max(...rows.map((row) => row.finishedAt?.getTime() ?? 0));
    expect(new Date(ended.lastFinishedAt).getTime()).toBe(lastEnd);

    // A run still going: the session hasn't finished, and its time counts to now.
    await h.db.update(runs).set({ status: RunStatus.Running, finishedAt: null }).where(eq(runs.id, opening));
    const going = (await h.asUser.expectOk(SESSIONS)).runSessions.sessions[0];
    expect(going).toMatchObject({ openRunCount: 1, lastFinishedAt: null, lastStatus: RunStatus.Cancelled });
    expect(going.runMs).toBeGreaterThan(0);
  });

  it('has no title when no run sent a user message with text', async () => {
    const { base } = await h.startRouter();
    const response = await h.complete(
      base,
      { model: 'helper', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PIXEL } }] }] },
      { 'x-session-id': 'picture' },
    );
    await response.text();
    const { runSessions } = await h.asUser.expectOk(SESSIONS);
    expect(runSessions.sessions).toEqual([expect.objectContaining({ key: 'picture', title: null })]);
  });

  it('cuts a long title at its length, with an ellipsis', () => {
    expect(titleOf('one two three', 9)).toBe('one two…');
    expect(titleOf('short', 9)).toBe('short');
    expect(titleOf('   ', 9)).toBeNull();
    expect(titleOf(null)).toBeNull();
  });

  it('is for people only: a workspace key never reads it', async () => {
    const app = await createWorkspaceWithKey(h.db, 'min-agent');
    const asApp = createClient(h.db, workspaceCaller(app.workspaceId, app.keyId));
    const refused = await asApp.expectError(SESSIONS);
    expect(refused.code).toBe('FORBIDDEN');
  });
});

describe('GET /runs', () => {
  it("lists the key's own workspace's runs, newest first, or one session's", async () => {
    h.script = () => ({ content: 'done' });
    const { base } = await h.startRouter();
    const first = await runOnce(base, 'helper', { 'x-session-id': 'chat-1' });
    const loose = await runOnce(base, 'helper');
    const second = await runOnce(base, 'helper', { 'x-session-id': 'chat-1' });
    const other = await createWorkspaceWithKey(h.db, 'min-agent');
    await h.offer(other.workspaceId, h.agentId);
    await h.snapshot.rebuild();
    await runOnce(base, 'helper', { 'x-session-id': 'chat-1', authorization: `Bearer ${other.secret}` });

    const all = await (await h.get(`${base}/runs`)).json();
    expect(all.runs.map((run: { id: string }) => run.id)).toEqual([second, loose, first]);
    const session = await (await h.get(`${base}/runs?session=chat-1&limit=1`)).json();
    expect(session.runs).toEqual([expect.objectContaining({ id: second, session: 'chat-1', agent: 'helper' })]);

    const refused = await h.get(`${base}/runs?limit=101`);
    expect(refused.status).toBe(HttpStatus.BadRequest);
    expect(await refused.json()).toMatchObject({ code: 'BAD_USER_INPUT' });
  });
});
