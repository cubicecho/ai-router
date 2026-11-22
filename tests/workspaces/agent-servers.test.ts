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
const GRANT = `mutation ($workspaceAgentId: UUID!, $serverIds: [UUID!]!) {
  setWorkspaceAgentServers(workspaceAgentId: $workspaceAgentId, serverIds: $serverIds)
}`;
const ENTRY = `query ($id: UUID!) {
  workspaceAgent(where: { id: { eq: $id } }) { servers { server { name } } }
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
 * Reads the servers the workspace's apps would reach with the agent, from the client's snapshot.
 *
 * @returns Their names, or null when the workspace may not run it.
 */
function reached(): readonly string[] | null {
  return runnableAgent(asUser.snapshot.current().agents, workspaceId, 'personal-finance')?.servers ?? null;
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
});

describe("an agent's servers in a workspace", () => {
  it('reaches none until a person grants some, whatever its document names', async () => {
    await asUser.snapshot.rebuild();
    expect(reached()).toEqual([]);
  });

  it('reaches exactly the servers granted, and a new grant replaces the old', async () => {
    const { setWorkspaceAgentServers } = await asUser.expectOk(GRANT, {
      workspaceAgentId: entryId,
      serverIds: [serverIds.actual, serverIds.actual],
    });
    expect(setWorkspaceAgentServers).toEqual([serverIds.actual]);
    expect(reached()).toEqual(['actual']);
    const { workspaceAgent } = await asUser.expectOk(ENTRY, { id: entryId });
    expect(workspaceAgent.servers).toEqual([{ server: { name: 'actual' } }]);

    await asUser.expectOk(GRANT, { workspaceAgentId: entryId, serverIds: [serverIds.github] });
    expect(reached()).toEqual(['github']);
    await asUser.expectOk(GRANT, { workspaceAgentId: entryId, serverIds: [] });
    expect(reached()).toEqual([]);
  });

  it('loses a grant when its server is deleted', async () => {
    await asUser.expectOk(GRANT, { workspaceAgentId: entryId, serverIds: [serverIds.actual, serverIds.github] });
    await db.delete(servers).where(eq(servers.id, serverIds.github));
    await asUser.snapshot.rebuild();
    expect(reached()).toEqual(['actual']);
  });

  it('refuses a server that does not exist, and an entry that does not, changing nothing', async () => {
    await asUser.expectOk(GRANT, { workspaceAgentId: entryId, serverIds: [serverIds.actual] });
    const missingId = '00000000-0000-4000-8000-000000000000';
    const unknownServer = await asUser.expectError(GRANT, { workspaceAgentId: entryId, serverIds: [missingId] });
    expect(unknownServer.code).toBe(ErrorCode.BadUserInput);
    const unknownEntry = await asUser.expectError(GRANT, { workspaceAgentId: missingId, serverIds: [] });
    expect(unknownEntry.code).toBe(ErrorCode.NotFound);
    expect(reached()).toEqual(['actual']);
  });

  it('is shut to a workspace key and to an agent run, whatever its roles', async () => {
    const asKey = createClient(db, workspaceCaller(workspaceId, keyId));
    const byKey = await asKey.expectError(GRANT, { workspaceAgentId: entryId, serverIds: [serverIds.actual] });
    expect(byKey.code).toBe(ErrorCode.Forbidden);
    const asRun = createClient(db, {
      kind: CALLER_RUN,
      runId: '00000000-0000-4000-8000-000000000001',
      workspaceId,
      agentId,
      roles: Object.values(AdminRole),
      depth: 1,
    });
    const byRun = await asRun.expectError(GRANT, { workspaceAgentId: entryId, serverIds: [serverIds.actual] });
    expect(byRun.code).toBe(ErrorCode.Forbidden);
    await asUser.snapshot.rebuild();
    expect(reached()).toEqual([]);
  });
});
