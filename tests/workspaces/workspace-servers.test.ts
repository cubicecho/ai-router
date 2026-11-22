import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runnableAgent } from '../../server/agents/start.ts';
import { AdminRole } from '../../server/core/admin-roles.ts';
import { CALLER_RUN, type UserCaller } from '../../server/core/context.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { providers } from '../../server/db/tables/providers.ts';
import { servers } from '../../server/db/tables/servers.ts';
import {
  closeTestDb,
  createClient,
  createTestDb,
  createUser,
  createWorkspaceWithKey,
  resetTestDb,
  type TestClient,
  type TestDb,
  workspaceCaller,
} from '../helpers.ts';

const CREATE_AGENT = 'mutation ($document: JSON!) { createAgent(document: $document) { id } }';
const OFFER = 'mutation ($v: CreateWorkspaceAgentInput!) { createWorkspaceAgent(values: $v) { id } }';
const SET_ENABLED = `mutation ($workspaceAgentId: UUID!, $serverId: UUID!, $enabled: Boolean!) {
  setWorkspaceAgentServerEnabled(workspaceAgentId: $workspaceAgentId, serverId: $serverId, enabled: $enabled)
}`;
const ADD = 'mutation ($values: CreateWorkspaceServerInput!) { createWorkspaceServer(values: $values) { id } }';
const REMOVE = 'mutation ($id: UUID!) { deleteWorkspaceServer(where: { id: { eq: $id } }) { id } }';
const ENTRY = `query ($id: UUID!) {
  workspaceAgent(where: { id: { eq: $id } }) { disabledServers { server { name } } }
}`;

/** An agent whose document names a server of its own, which the router doesn't read. */
const FINANCE = {
  spec: 'cubicecho.agent/2',
  id: 'personal-finance',
  model: { model: 'ollama/qwen3:32b' },
  prompt: [{ role: 'system', name: 'identity', content: 'You help me run my household money.' }],
  tools: { servers: ['github'] },
};

let db: TestDb;
let user: UserCaller;
let asUser: TestClient;
let workspaceId: string;
let keyId: string;
let agentId: string;
let entryId: string;
let otherEntryId: string;
let serverIds: Record<'actual' | 'github', string>;

/**
 * Adds a server the router runs as a program.
 *
 * @param name - Its name.
 * @returns Its id.
 */
async function addServer(name: string): Promise<string> {
  const [server] = await db
    .insert(servers)
    .values({ name, source: { type: 'manual' }, transport: { type: 'stdio', command: 'node', args: [] } })
    .returning({ id: servers.id });
  if (server === undefined) {
    throw new Error('The server was not inserted.');
  }
  return server.id;
}

/**
 * Reads the servers the workspace's apps would reach with an agent, from the client's snapshot.
 *
 * @param [name] - The agent.
 * @returns Their names, or null when the workspace may not run it.
 */
function reached(name = 'personal-finance'): readonly string[] | null {
  return runnableAgent(asUser.snapshot.current().agents, workspaceId, name)?.servers ?? null;
}

/**
 * Adds a server to the workspace, overriding nothing, as a person does on the workspace page.
 *
 * @param serverId - The server.
 * @returns The workspace's entry for it.
 */
async function add(serverId: string): Promise<string> {
  return (await asUser.expectOk(ADD, { values: { workspaceId, serverId } })).createWorkspaceServer.id;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
  user = await createUser(db, 'user@example.com');
  asUser = createClient(db, user);
  await db.insert(providers).values({ name: 'ollama', baseUrl: 'http://ollama:11434/v1' });
  serverIds = { actual: await addServer('actual'), github: await addServer('github') };
  ({ workspaceId, keyId } = await createWorkspaceWithKey(db, 'task-server'));
  agentId = (await asUser.expectOk(CREATE_AGENT, { document: FINANCE })).createAgent.id;
  entryId = (await asUser.expectOk(OFFER, { v: { workspaceId, agentId } })).createWorkspaceAgent.id;
  const coderId = (await asUser.expectOk(CREATE_AGENT, { document: { ...FINANCE, id: 'coder' } })).createAgent.id;
  otherEntryId = (await asUser.expectOk(OFFER, { v: { workspaceId, agentId: coderId } })).createWorkspaceAgent.id;
});

describe("a workspace's servers", () => {
  it('reach no agent while the workspace has none, whatever its document names', async () => {
    await asUser.snapshot.rebuild();
    expect(reached()).toEqual([]);
  });

  it('reach every agent there once added, a new one too', async () => {
    await add(serverIds.github);
    await add(serverIds.actual);
    expect(reached()).toEqual(['actual', 'github']);
    expect(reached('coder')).toEqual(['actual', 'github']);
    const laterId = (await asUser.expectOk(CREATE_AGENT, { document: { ...FINANCE, id: 'later' } })).createAgent.id;
    await asUser.expectOk(OFFER, { v: { workspaceId, agentId: laterId } });
    expect(reached('later')).toEqual(['actual', 'github']);
  });

  it('are left out for an agent they are turned off for, and only for it, until turned on again', async () => {
    await add(serverIds.actual);
    await add(serverIds.github);
    const off = { workspaceAgentId: entryId, serverId: serverIds.github, enabled: false };
    const { setWorkspaceAgentServerEnabled } = await asUser.expectOk(SET_ENABLED, off);
    expect(setWorkspaceAgentServerEnabled).toBe(false);
    // Turning it off twice is the same as once.
    await asUser.expectOk(SET_ENABLED, off);
    expect(reached()).toEqual(['actual']);
    expect(reached('coder')).toEqual(['actual', 'github']);
    const { workspaceAgent } = await asUser.expectOk(ENTRY, { id: entryId });
    expect(workspaceAgent.disabledServers).toEqual([{ server: { name: 'github' } }]);

    await asUser.expectOk(SET_ENABLED, { ...off, enabled: true });
    expect(reached()).toEqual(['actual', 'github']);
  });

  it('reach every agent again when taken out and added back', async () => {
    const githubEntry = await add(serverIds.github);
    await asUser.expectOk(SET_ENABLED, { workspaceAgentId: entryId, serverId: serverIds.github, enabled: false });
    await asUser.expectOk(REMOVE, { id: githubEntry });
    expect(reached()).toEqual([]);
    await add(serverIds.github);
    expect(reached()).toEqual(['github']);
  });

  it('are gone from every agent when the server is deleted', async () => {
    await add(serverIds.actual);
    await add(serverIds.github);
    await db.delete(servers).where(eq(servers.id, serverIds.github));
    await asUser.snapshot.rebuild();
    expect(reached()).toEqual(['actual']);
  });

  it('can be turned off only where the workspace has the server and runs the agent, changing nothing', async () => {
    await add(serverIds.actual);
    const missingId = '00000000-0000-4000-8000-000000000000';
    const notThere = await asUser.expectError(SET_ENABLED, {
      workspaceAgentId: entryId,
      serverId: serverIds.github,
      enabled: false,
    });
    expect(notThere.code).toBe(ErrorCode.NotFound);
    const unknownEntry = await asUser.expectError(SET_ENABLED, {
      workspaceAgentId: missingId,
      serverId: serverIds.actual,
      enabled: false,
    });
    expect(unknownEntry.code).toBe(ErrorCode.NotFound);
    expect(reached()).toEqual(['actual']);
  });

  it('include the admin server like any other, for every agent unless turned off', async () => {
    const admin = asUser.snapshot.current().servers.get('ai-router');
    await add(admin?.id ?? '');
    expect(reached()).toEqual(['ai-router']);
    await asUser.expectOk(SET_ENABLED, { workspaceAgentId: otherEntryId, serverId: admin?.id, enabled: false });
    expect(reached('coder')).toEqual([]);
    expect(reached()).toEqual(['ai-router']);
  });

  it('are added and turned on only by a person, never a workspace key or an agent run, whatever its roles', async () => {
    await add(serverIds.actual);
    await asUser.expectOk(SET_ENABLED, { workspaceAgentId: entryId, serverId: serverIds.actual, enabled: false });
    const asKey = createClient(db, workspaceCaller(workspaceId, keyId));
    const asRun = createClient(db, {
      kind: CALLER_RUN,
      runId: '00000000-0000-4000-8000-000000000001',
      workspaceId,
      agentId,
      roles: Object.values(AdminRole),
      depth: 1,
    });
    for (const caller of [asKey, asRun]) {
      const turnOn = await caller.expectError(SET_ENABLED, {
        workspaceAgentId: entryId,
        serverId: serverIds.actual,
        enabled: true,
      });
      expect(turnOn.code).toBe(ErrorCode.Forbidden);
      const addOne = await caller.expectError(ADD, { values: { workspaceId, serverId: serverIds.github } });
      expect(addOne.code).toBe(ErrorCode.Forbidden);
    }
    await asUser.snapshot.rebuild();
    expect(reached()).toEqual([]);
  });
});
