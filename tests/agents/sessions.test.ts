import { describe, expect, it } from 'vitest';
import { HttpStatus } from '../../server/core/wire.ts';
import { runs } from '../../server/db/tables/runs.ts';
import { createClient, createWorkspaceWithKey, workspaceCaller } from '../helpers.ts';
import { CREATE_AGENT, GRANT, lastMessage, QUESTION, useRunHarness } from './run-harness.ts';

// A session is the runs one workspace's app sent under one key, `X-Conversation-Id` or else `X-Session-Id`, whichever
// agents ran them. It is a label: the runs screen groups by it, and an app lists a session's runs at /runs.

const h = useRunHarness();

const SESSIONS = `query ($workspaceId: UUID, $agentName: String, $limit: Int, $offset: Int) {
  runSessions(workspaceId: $workspaceId, agentName: $agentName, limit: $limit, offset: $offset) {
    count
    sessions { key workspaceId workspaceName agentNames runCount openRunCount startedAt lastStartedAt inputTokens outputTokens }
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
    document: { spec: 'cubicecho.agent/1', id, model: { model: 'fake/m1' }, tools: { servers: [] } },
  });
  await h.asUser.expectOk(GRANT, { v: { workspaceId: h.workspaceId, agentId: createAgent.id } });
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
    await h.asUser.expectOk(GRANT, { v: { workspaceId: other.workspaceId, agentId: h.agentId } });
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
    await h.asUser.expectOk(GRANT, { v: { workspaceId: other.workspaceId, agentId: h.agentId } });
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
