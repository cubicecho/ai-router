import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runnableAgent } from '../../server/agents/start.ts';
import { AdminRole } from '../../server/core/admin-roles.ts';
import { CALLER_RUN, type UserCaller } from '../../server/core/context.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { providers } from '../../server/db/tables/providers.ts';
import { SecretKind, serverSecrets } from '../../server/db/tables/server-secrets.ts';
import { servers } from '../../server/db/tables/servers.ts';
import { workspaceAgentDisabledServers } from '../../server/db/tables/workspace-agent-disabled-servers.ts';
import { workspaceAgentDisabledTools } from '../../server/db/tables/workspace-agent-disabled-tools.ts';
import { workspaceAgents } from '../../server/db/tables/workspace-agents.ts';
import { workspaceKeys } from '../../server/db/tables/workspace-keys.ts';
import { workspaceServers } from '../../server/db/tables/workspace-servers.ts';
import { workspaces } from '../../server/db/tables/workspaces.ts';
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
const COPY = `mutation ($fromWorkspaceId: UUID!, $slug: String!, $name: String!, $description: String) {
  copyWorkspace(fromWorkspaceId: $fromWorkspaceId, slug: $slug, name: $name, description: $description) {
    id slug name description
  }
}`;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

/** An agent the workspaces run. */
const FINANCE = {
  spec: 'cubicecho.agent/2',
  id: 'personal-finance',
  model: { model: 'ollama/qwen3:32b' },
  prompt: [{ role: 'system', name: 'identity', content: 'You help me run my household money.' }],
};

let db: TestDb;
let user: UserCaller;
let asUser: TestClient;
let sourceId: string;
let keyId: string;
let financeEntryId: string;
let coderEntryId: string;
let serverIds: Record<'actual' | 'github' | 'admin', string>;

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
 * Puts an agent in the source workspace, as a person does.
 *
 * @param id - The agent's name.
 * @returns The workspace's entry for it.
 */
async function offer(id: string): Promise<string> {
  const agentId = (await asUser.expectOk(CREATE_AGENT, { document: { ...FINANCE, id } })).createAgent.id;
  return (await asUser.expectOk(OFFER, { v: { workspaceId: sourceId, agentId } })).createWorkspaceAgent.id;
}

/**
 * Reads the servers a workspace's apps would reach with an agent, from the client's snapshot.
 *
 * @param workspaceId - The workspace.
 * @param name - The agent.
 * @returns Their names, or null when the workspace may not run it.
 */
function reached(workspaceId: string, name: string): readonly string[] | null {
  return runnableAgent(asUser.snapshot.current().agents, workspaceId, name)?.servers ?? null;
}

/**
 * Reads a workspace's server entries, by the server's id.
 *
 * @param workspaceId - The workspace.
 * @returns Its entries.
 */
async function entriesOf(workspaceId: string) {
  const rows = await db.select().from(workspaceServers).where(eq(workspaceServers.workspaceId, workspaceId));
  return new Map(rows.map((row) => [row.serverId, row]));
}

/**
 * Copies the source workspace as a person does.
 *
 * @param [slug] - The new workspace's slug.
 * @returns The new workspace's id.
 */
async function copy(slug = 'second-app'): Promise<string> {
  const { copyWorkspace } = await asUser.expectOk(COPY, { fromWorkspaceId: sourceId, slug, name: 'Second app' });
  return copyWorkspace.id;
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
  await asUser.snapshot.rebuild();
  serverIds = {
    actual: await addServer('actual'),
    github: await addServer('github'),
    admin: asUser.snapshot.current().servers.get('ai-router')?.id ?? '',
  };
  ({ workspaceId: sourceId, keyId } = await createWorkspaceWithKey(db, 'task-server'));
  financeEntryId = await offer('personal-finance');
  coderEntryId = await offer('coder');
  await db.insert(workspaceServers).values([
    { workspaceId: sourceId, serverId: serverIds.actual, env: { BUDGET: 'household' }, args: ['--read-only'] },
    { workspaceId: sourceId, serverId: serverIds.github, url: null },
    { workspaceId: sourceId, serverId: serverIds.admin, roles: [AdminRole.AgentsRead, AdminRole.RunsRead] },
  ]);
  await db.insert(workspaceAgentDisabledServers).values([
    { workspaceAgentId: financeEntryId, serverId: serverIds.github },
    { workspaceAgentId: coderEntryId, serverId: serverIds.actual },
  ]);
  await db
    .insert(workspaceAgentDisabledTools)
    .values({ workspaceAgentId: coderEntryId, serverId: serverIds.github, tool: 'delete_repo' });
  await db.insert(serverSecrets).values([
    { serverId: serverIds.actual, workspaceId: sourceId, kind: SecretKind.Env, name: 'TOKEN', value: 'household-1' },
    { serverId: serverIds.actual, workspaceId: null, kind: SecretKind.Env, name: 'TOKEN', value: 'base-1' },
  ]);
  await asUser.snapshot.rebuild();
});

describe('copying a workspace', () => {
  it('makes a workspace with the same agents, and the same reach for each', async () => {
    const copyId = await copy();
    for (const agent of ['personal-finance', 'coder']) {
      expect(reached(copyId, agent)).toEqual(reached(sourceId, agent));
    }
    expect(reached(copyId, 'personal-finance')).toEqual(['actual', 'ai-router']);
    expect(reached(copyId, 'coder')).toEqual(['ai-router', 'github']);
    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, copyId));
    expect(workspace).toMatchObject({ slug: 'second-app', name: 'Second app', description: '' });
  });

  it("copies each server's non-secret settings and the admin server's roles, on entries of its own", async () => {
    const copyId = await copy();
    const source = await entriesOf(sourceId);
    const copied = await entriesOf(copyId);
    expect([...copied.keys()].sort()).toEqual([...source.keys()].sort());
    for (const [serverId, entry] of copied) {
      const from = source.get(serverId);
      expect(entry).toMatchObject({ env: from?.env, args: from?.args, url: from?.url, roles: from?.roles });
      expect(entry.childUid).not.toBe(from?.childUid);
      expect(entry.installDir).toBeNull();
    }
    expect(copied.get(serverIds.actual)).toMatchObject({ env: { BUDGET: 'household' }, args: ['--read-only'] });
    const adminEntry = asUser.snapshot.current().servers.get('ai-router')?.entries.get(copyId);
    expect(adminEntry?.roles).toEqual([AdminRole.AgentsRead, AdminRole.RunsRead]);
  });

  it('copies the tools turned off for each agent', async () => {
    const copyId = await copy();
    const [coderCopy] = await db
      .select({ id: workspaceAgents.id })
      .from(workspaceAgents)
      .innerJoin(workspaceAgentDisabledTools, eq(workspaceAgentDisabledTools.workspaceAgentId, workspaceAgents.id))
      .where(eq(workspaceAgents.workspaceId, copyId));
    const tools = await db
      .select({ serverId: workspaceAgentDisabledTools.serverId, tool: workspaceAgentDisabledTools.tool })
      .from(workspaceAgentDisabledTools)
      .where(eq(workspaceAgentDisabledTools.workspaceAgentId, coderCopy?.id ?? MISSING_ID));
    expect(tools).toEqual([{ serverId: serverIds.github, tool: 'delete_repo' }]);
    expect(coderCopy?.id).not.toBe(coderEntryId);
  });

  it('never copies keys or secrets', async () => {
    const copyId = await copy();
    expect(await db.select().from(workspaceKeys).where(eq(workspaceKeys.workspaceId, copyId))).toEqual([]);
    expect(await db.select().from(serverSecrets).where(eq(serverSecrets.workspaceId, copyId))).toEqual([]);
    expect(await db.select().from(serverSecrets)).toHaveLength(2);
  });

  it('refuses a bad slug, a taken one or an unknown source, changing nothing', async () => {
    const refusals = [
      { args: { fromWorkspaceId: sourceId, slug: 'Bad Slug', name: 'x' }, code: ErrorCode.BadUserInput },
      { args: { fromWorkspaceId: sourceId, slug: 'task-server', name: 'x' }, code: ErrorCode.BadUserInput },
      { args: { fromWorkspaceId: sourceId, slug: 'second-app', name: ' ' }, code: ErrorCode.BadUserInput },
      { args: { fromWorkspaceId: MISSING_ID, slug: 'second-app', name: 'x' }, code: ErrorCode.NotFound },
    ];
    for (const { args, code } of refusals) {
      expect((await asUser.expectError(COPY, args)).code).toBe(code);
    }
    expect(await db.select({ id: workspaces.id }).from(workspaces)).toEqual([{ id: sourceId }]);
    expect(await db.select().from(workspaceServers)).toHaveLength(3);
  });

  it('is done only by a person, never a workspace key or an agent run, whatever its roles', async () => {
    const asKey = createClient(db, workspaceCaller(sourceId, keyId));
    const asRun = createClient(db, {
      kind: CALLER_RUN,
      runId: '00000000-0000-4000-8000-000000000001',
      workspaceId: sourceId,
      agentId: MISSING_ID,
      roles: Object.values(AdminRole),
      depth: 1,
    });
    for (const caller of [asKey, asRun]) {
      const refused = await caller.expectError(COPY, { fromWorkspaceId: sourceId, slug: 'second-app', name: 'x' });
      expect(refused.code).toBe(ErrorCode.Forbidden);
    }
    expect(await db.select({ id: workspaces.id }).from(workspaces)).toEqual([{ id: sourceId }]);
  });
});
