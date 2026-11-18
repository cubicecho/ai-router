import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { graphql } from 'graphql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRunService } from '../../server/agents/run.ts';
import { fixedAuthHost } from '../../server/auth/auth-host.ts';
import { createRateLimiter } from '../../server/auth/rate-limit.ts';
import { AdminRole } from '../../server/core/admin-roles.ts';
import { CALLER_RUN, type ContextDeps, type UserCaller } from '../../server/core/context.ts';
import { MCP_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { createSnapshotHost, type SnapshotHost } from '../../server/db/snapshot.ts';
import { servers } from '../../server/db/tables/servers.ts';
import { FIELD_GRANTS } from '../../server/graphql/abilities.ts';
import { createSchema } from '../../server/graphql/build-schema.ts';
import { createRunContextFactory } from '../../server/graphql/handler.ts';
import { createApp } from '../../server/http/app.ts';
import { createModelServices } from '../../server/models/services.ts';
import type { RunToolCall } from '../../server/tools/api.ts';
import { ChildMode } from '../../server/tools/child-users.ts';
import { resolveServer } from '../../server/tools/resolve.ts';
import { createToolServices, type ToolServiceParts } from '../../server/tools/services.ts';
import { RESERVED_SERVER_NAME } from '../../server/tools/shapes.ts';
import {
  closeTestDb,
  createClient,
  createTestAuth,
  createTestDb,
  createUser,
  createWorkspaceWithKey,
  resetTestDb,
  type TestClient,
  type TestDb,
} from '../helpers.ts';

// The admin server `ai-router`, connected in process through the tools area as the app wires it: a workspace's
// runs are listed the tools its entry's roles reach, and each call executes as the run that made it.

const CREATE_ENTRY = `mutation ($values: CreateWorkspaceServerInput!) {
  createWorkspaceServer(values: $values) { id }
}`;
const UPDATE_ENTRY = `mutation ($id: UUID!, $set: UpdateWorkspaceServerInput!) {
  updateWorkspaceServer(where: { id: { eq: $id } }, set: $set) { id }
}`;
const CREATE_AGENT = 'mutation ($document: JSON!) { createAgent(document: $document) { id } }';

/** What `agents:read` is listed, by tool name. */
const AGENT_READS = ['agent', 'agent_revision', 'agent_revisions', 'agents', 'check_agent'];
/** The fields a role reaches that the listing leaves out: `UNLISTED_FIELDS`. */
const UNLISTED = /(Aggregate|GroupBy)$/;

/** The run every call in these tests is made for. */
const RUN: RunToolCall = { agentId: 'agent-1', agentName: 'helper', runId: 'run-1' };

let db: TestDb;
let root: string;
let snapshot: SnapshotHost;
let tools: ToolServiceParts;
let user: UserCaller;
let asUser: TestClient;
let adminServerId: string;
let workspaceId: string;

/**
 * Gives the test workspace an entry for the admin server.
 *
 * @param roles - What it grants.
 * @returns The entry's id.
 */
async function grant(roles: AdminRole[]): Promise<string> {
  const { createWorkspaceServer } = await asUser.expectOk(CREATE_ENTRY, {
    values: { workspaceId, serverId: adminServerId, roles },
  });
  return createWorkspaceServer.id;
}

/**
 * Lists the admin server's tools as a workspace's runs see them.
 *
 * @param workspace - The workspace, or null for the listing a person sees.
 * @returns The tool names, sorted.
 */
async function toolNames(workspace: string | null): Promise<string[]> {
  return (await tools.listTools(adminServerId, workspace)).map((tool) => tool.name).sort();
}

beforeAll(async () => {
  db = await createTestDb();
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-router-admin-')));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await closeTestDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  snapshot = await createSnapshotHost(db);
  tools = createToolServices({ db, snapshot, isolation: { mode: ChildMode.Shared, reason: '' }, folders: { root } });
  // The app hands the tools area its admin server.
  await createApp({ db, authHost: fixedAuthHost(createTestAuth(db)), snapshot, tools });
  user = await createUser(db, 'user@example.com');
  asUser = createClient(db, user, { snapshot, tools });
  ({ workspaceId } = await createWorkspaceWithKey(db, 'household'));
  await snapshot.rebuild();
  const [row] = await db.select({ id: servers.id }).from(servers).where(eq(servers.name, RESERVED_SERVER_NAME));
  adminServerId = row?.id ?? '';
});

afterEach(() => tools.stop());

describe('the tools a run is listed', () => {
  it('are none without an entry, or with one that grants no roles', async () => {
    expect(await toolNames(workspaceId)).toEqual([]);
    await grant([]);
    expect(await toolNames(workspaceId)).toEqual([]);
  });

  it('are what the roles reach, and no more', async () => {
    const entryId = await grant([AdminRole.AgentsRead]);
    expect(await toolNames(workspaceId)).toEqual(AGENT_READS);

    await asUser.expectOk(UPDATE_ENTRY, { id: entryId, set: { roles: [AdminRole.RunsRead] } });
    expect(await toolNames(workspaceId)).toEqual(['run', 'runs']);

    await asUser.expectOk(UPDATE_ENTRY, { id: entryId, set: { roles: [AdminRole.AgentsManage] } });
    const managed = await toolNames(workspaceId);
    expect(managed).toEqual(expect.arrayContaining([...AGENT_READS, 'create_agent', 'save_agent']));
    expect(managed).not.toContain('delete_agent');
    expect(managed).not.toContain('promote_revision');
  });

  it("never include a person's own fields: secrets, users, workspaces and keys", async () => {
    const every = await toolNames(null);
    const listed = [...Object.keys(FIELD_GRANTS.Query), ...Object.keys(FIELD_GRANTS.Mutation)].filter(
      (field) => UNLISTED.test(field) === false,
    );
    expect(every).toHaveLength(listed.length);
    for (const name of ['set_server_secret', 'set_provider_api_key', 'users', 'workspaces', 'create_workspace_key']) {
      expect(every).not.toContain(name);
    }
  });

  it('fit the size budgets', async () => {
    const every = await tools.instances.listTools(resolveServer(snapshotServer(), null, INSTANCE_TIMEOUTS));
    for (const tool of every) {
      expect(JSON.stringify(tool).length, tool.name).toBeLessThanOrEqual(MCP_DEFAULTS.maxToolSchemaBytes);
    }
    expect(JSON.stringify({ tools: every }).length).toBeLessThanOrEqual(MCP_DEFAULTS.maxToolListBytes);
  });
});

/** Timeouts for resolving the admin server by hand. */
const INSTANCE_TIMEOUTS = { idleTimeoutMs: 1000, callTimeoutMs: 10_000 };

/**
 * Reads the admin server from the snapshot.
 *
 * @returns It.
 */
function snapshotServer() {
  const found = snapshot.current().servers.get(RESERVED_SERVER_NAME);
  if (found === undefined) {
    throw new Error('The admin server is not in the snapshot.');
  }
  return found;
}

describe('a call to the admin server', () => {
  it('runs as the run that made it, and answers what its roles may read', async () => {
    await asUser.expectOk(CREATE_AGENT, {
      document: { spec: 'cubicecho.agent/1', id: 'helper', model: { model: 'fake/m1' }, tools: { servers: [] } },
    });
    await grant([AdminRole.AgentsRead]);
    const result = await tools.callTool(adminServerId, workspaceId, 'agents', {}, RUN);
    expect(result.isError).toBe(false);
    const [content] = result.content;
    const body = JSON.parse(content?.type === 'text' ? content.text : '{}');
    expect(body.data.agents).toEqual([expect.objectContaining({ name: 'helper' })]);
  });

  it('never changes or restarts the admin server itself, whatever the roles', async () => {
    await grant([AdminRole.ServersManage, AdminRole.ServersOperate]);
    const calls = [
      ['update_server', { where: { id: { eq: adminServerId } }, set: { enabled: false } }],
      ['restart_server', { id: adminServerId, workspaceId }],
    ] as const;
    for (const [tool, args] of calls) {
      const result = await tools.callTool(adminServerId, workspaceId, tool, args, RUN);
      expect(result.isError, tool).toBe(true);
      const [content] = result.content;
      const body = JSON.parse(content?.type === 'text' ? content.text : '{}');
      expect(body.errors[0].extensions.code, tool).toBe(ErrorCode.BadUserInput);
    }
    expect(snapshotServer().enabled).toBe(true);
  });

  it('is refused when it names no run, as a person trying it does', async () => {
    await grant([AdminRole.AgentsRead]);
    const { code } = await asUser.expectError(
      'mutation ($id: UUID!, $w: UUID) { tryServerTool(id: $id, workspaceId: $w, tool: "agents") }',
      {
        id: adminServerId,
        w: workspaceId,
      },
    );
    expect(code).toBe(ErrorCode.BadUserInput);
    const unnamed = await tools.instances.callTool(
      resolveServer(snapshotServer(), workspaceId, INSTANCE_TIMEOUTS),
      'agents',
      {},
    );
    expect(unnamed.isError).toBe(true);
  });

  it('is refused with FORBIDDEN past its roles, by the same permissions /graphql has', async () => {
    const models = createModelServices({
      db,
      snapshot,
      fetch: async (url) => {
        throw new Error(`No provider is reachable in this test (${url}).`);
      },
    });
    const deps: ContextDeps = {
      db,
      authHost: fixedAuthHost(createTestAuth(db)),
      snapshot,
      limiter: createRateLimiter(),
      models,
      tools,
      runs: createRunService({ db, snapshot, tools }),
    };
    const contextValue = createRunContextFactory(deps)({
      kind: CALLER_RUN,
      runId: RUN.runId,
      agentId: RUN.agentId,
      workspaceId,
      roles: [AdminRole.AgentsRead],
    });
    const result = await graphql({
      schema: createSchema(db),
      source:
        'mutation { createAgent(document: { spec: "cubicecho.agent/1", id: "x", model: { model: "fake/m1" } }) { id } }',
      contextValue,
    });
    expect(result.errors?.[0]?.extensions.code).toBe(ErrorCode.Forbidden);
  });
});
