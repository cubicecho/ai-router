import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminRole } from '../../server/core/admin-roles.ts';
import type { UserCaller } from '../../server/core/context.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { servers } from '../../server/db/tables/servers.ts';
import { Role } from '../../server/db/tables/users.ts';
import { workspaceServers } from '../../server/db/tables/workspace-servers.ts';
import {
  ADMIN_SERVER_ROW,
  RESERVED_SERVER_NAME,
  SourceType,
  TRANSPORT_BUILTIN,
  TRANSPORT_STDIO,
} from '../../server/tools/shapes.ts';
import {
  closeTestDb,
  createClient,
  createTestDb,
  createUser,
  createWorkspaceWithKey,
  resetTestDb,
  type TestClient,
  type TestDb,
} from '../helpers.ts';

// The admin server's row: the migrations add it, and nobody adds another, renames it, deletes it, or gives it a
// transport, env, secrets or a login. Its entries grant roles and nothing else, and only its entries hold roles.

const INSTALL = 'mutation ($input: InstallServerInput!) { installServer(input: $input) { id } }';
const UPDATE_SERVER = `mutation ($id: UUID!, $set: UpdateServerInput!) {
  updateServer(where: { id: { eq: $id } }, set: $set) { id name enabled displayName description }
}`;
const DELETE = 'mutation ($id: UUID!) { deleteServer(id: $id) }';
const SET_SECRET = `mutation ($serverId: UUID!, $workspaceId: UUID) {
  setServerSecret(serverId: $serverId, workspaceId: $workspaceId, kind: "env", name: "TOKEN", value: "x") { id }
}`;
const START_LOGIN = 'mutation ($id: UUID!) { startServerLogin(serverId: $id) { signedIn } }';
const SIGN_OUT = 'mutation ($id: UUID!) { signOutServer(serverId: $id) { id } }';
const LOGIN_CLIENT = `mutation ($id: UUID!) {
  setServerLoginClient(serverId: $id, client: { clientId: "c" }) { clientRegistered }
}`;
const TRY = 'mutation ($id: UUID!) { tryServerTool(id: $id, tool: "agents") }';
const CREATE_ENTRY = `mutation ($values: CreateWorkspaceServerInput!) {
  createWorkspaceServer(values: $values) { id roles }
}`;
const UPDATE_ENTRY = `mutation ($id: UUID!, $set: UpdateWorkspaceServerInput!) {
  updateWorkspaceServer(where: { id: { eq: $id } }, set: $set) { id roles }
}`;

let db: TestDb;
let admin: UserCaller;
let asAdmin: TestClient;
let adminServerId: string;
let workspaceId: string;

/**
 * Adds a stdio server straight to the table.
 *
 * @param name - Its name.
 * @returns Its id.
 */
async function addServer(name: string): Promise<string> {
  const [row] = await db
    .insert(servers)
    .values({
      name,
      source: { type: SourceType.Manual },
      transport: { type: TRANSPORT_STDIO, command: 'node', args: ['server.js'] },
    })
    .returning({ id: servers.id });
  if (row === undefined) {
    throw new Error('no row');
  }
  return row.id;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
  admin = await createUser(db, 'admin@example.com', Role.Admin);
  asAdmin = createClient(db, admin);
  const [row] = await db.select({ id: servers.id }).from(servers).where(eq(servers.name, RESERVED_SERVER_NAME));
  adminServerId = row?.id ?? '';
  ({ workspaceId } = await createWorkspaceWithKey(db, 'household'));
});

describe('the admin server row', () => {
  it('is on every router, built in', async () => {
    const [row] = await db.select().from(servers).where(eq(servers.id, adminServerId));
    expect(row).toMatchObject({ ...ADMIN_SERVER_ROW, env: {}, enabled: true });
  });

  it('is the only built-in server: nothing installs or adds another', async () => {
    const asked = [
      { name: 'mine', source: { type: SourceType.Builtin } },
      { name: 'mine', source: { type: SourceType.Manual }, transport: { type: TRANSPORT_BUILTIN } },
      {
        name: RESERVED_SERVER_NAME,
        source: { type: SourceType.Manual },
        transport: { type: TRANSPORT_STDIO, command: 'node' },
      },
    ];
    for (const input of asked) {
      const { code } = await asAdmin.expectError(INSTALL, { input });
      expect(code).toBe(ErrorCode.BadUserInput);
    }
    const insertBuiltin = db.insert(servers).values({ ...ADMIN_SERVER_ROW, name: 'second' });
    await expect(insertBuiltin).rejects.toThrow();
  });

  it('keeps its name, transport and env, and lets its display name, description and switch change', async () => {
    const refused = [
      { name: 'renamed' },
      { transport: { type: TRANSPORT_STDIO, command: 'node', args: [] } },
      { env: { A: 'b' } },
      { callTimeoutMs: 1000 },
    ];
    for (const set of refused) {
      const { code } = await asAdmin.expectError(UPDATE_SERVER, { id: adminServerId, set });
      expect(code).toBe(ErrorCode.BadUserInput);
    }
    const otherId = await addServer('other');
    const { code } = await asAdmin.expectError(UPDATE_SERVER, { id: otherId, set: { transport: { type: 'builtin' } } });
    expect(code).toBe(ErrorCode.BadUserInput);

    const set = { enabled: false, displayName: 'Router admin', description: 'Mine.' };
    const { updateServer } = await asAdmin.expectOk(UPDATE_SERVER, { id: adminServerId, set });
    expect(updateServer).toEqual({ id: adminServerId, name: RESERVED_SERVER_NAME, ...set });
  });

  it('cannot be deleted, given secrets, signed in to, or tried by a person', async () => {
    const refusals = [
      [DELETE, { id: adminServerId }],
      [SET_SECRET, { serverId: adminServerId }],
      [SET_SECRET, { serverId: adminServerId, workspaceId }],
      [START_LOGIN, { id: adminServerId }],
      [SIGN_OUT, { id: adminServerId }],
      [LOGIN_CLIENT, { id: adminServerId }],
      [TRY, { id: adminServerId }],
    ] as const;
    for (const [operation, variables] of refusals) {
      const { code } = await asAdmin.expectError(operation, variables);
      expect(code).toBe(ErrorCode.BadUserInput);
    }
    expect(await db.select({ id: servers.id }).from(servers).where(eq(servers.id, adminServerId))).toHaveLength(1);
  });
});

describe('roles on server entries', () => {
  it('are kept on an entry for the admin server', async () => {
    const roles = [AdminRole.AgentsRead, AdminRole.RunsRead];
    const { createWorkspaceServer } = await asAdmin.expectOk(CREATE_ENTRY, {
      values: { workspaceId, serverId: adminServerId, roles },
    });
    expect(createWorkspaceServer.roles).toEqual(roles);
    const { updateWorkspaceServer } = await asAdmin.expectOk(UPDATE_ENTRY, {
      id: createWorkspaceServer.id,
      set: { roles: [AdminRole.ServersOperate] },
    });
    expect(updateWorkspaceServer).toEqual({ id: createWorkspaceServer.id, roles: [AdminRole.ServersOperate] });
  });

  it('are refused when unknown or listed twice', async () => {
    for (const roles of [['agents:delete'], [AdminRole.AgentsRead, AdminRole.AgentsRead]]) {
      const { code } = await asAdmin.expectError(CREATE_ENTRY, {
        values: { workspaceId, serverId: adminServerId, roles },
      });
      expect(code).toBe(ErrorCode.BadUserInput);
    }
  });

  it("are refused on another server's entry, and the admin server's entry takes nothing but roles", async () => {
    const otherId = await addServer('other');
    const onOther = await asAdmin.expectError(CREATE_ENTRY, {
      values: { workspaceId, serverId: otherId, roles: [AdminRole.AgentsRead] },
    });
    expect(onOther.code).toBe(ErrorCode.BadUserInput);
    for (const config of [{ env: { A: 'b' } }, { args: ['--x'] }, { url: 'https://example.com/mcp' }]) {
      const { code } = await asAdmin.expectError(CREATE_ENTRY, {
        values: { workspaceId, serverId: adminServerId, ...config },
      });
      expect(code).toBe(ErrorCode.BadUserInput);
    }
    const { createWorkspaceServer } = await asAdmin.expectOk(CREATE_ENTRY, {
      values: { workspaceId, serverId: otherId },
    });
    const later = await asAdmin.expectError(UPDATE_ENTRY, {
      id: createWorkspaceServer.id,
      set: { roles: [AdminRole.AgentsRead] },
    });
    expect(later.code).toBe(ErrorCode.BadUserInput);
    expect(await db.select().from(workspaceServers)).toEqual([
      expect.objectContaining({ serverId: otherId, roles: [] }),
    ]);
  });
});
