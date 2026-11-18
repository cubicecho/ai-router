import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserCaller } from '../../server/core/context.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { createSnapshotHost } from '../../server/db/snapshot.ts';
import { servers } from '../../server/db/tables/servers.ts';
import { Role } from '../../server/db/tables/users.ts';
import { resolveServer } from '../../server/tools/resolve.ts';
import { SourceType, TRANSPORT_STDIO, TRANSPORT_STREAMABLE_HTTP } from '../../server/tools/shapes.ts';
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

const SECRET = 'planted-server-secret-value';
const TIMEOUTS = { idleTimeoutMs: 1000, callTimeoutMs: 2000 };

const SET_SECRET = `mutation ($serverId: UUID!, $workspaceId: UUID, $kind: String!, $name: String!, $value: String) {
  setServerSecret(serverId: $serverId, workspaceId: $workspaceId, kind: $kind, name: $name, value: $value) {
    id secrets { kind name workspaceId }
  }
}`;
const UPDATE_SERVER = `mutation ($id: UUID!, $set: UpdateServerInput!) {
  updateServer(where: { id: { eq: $id } }, set: $set) { id name env enabled }
}`;
const CREATE_ENTRY = `mutation ($values: CreateWorkspaceServerInput!) {
  createWorkspaceServer(values: $values) { id env args url }
}`;
const CREATE_REGISTRY = `mutation ($values: CreateRegistryInput!) {
  createRegistry(values: $values) { id name url }
}`;
const EVERYTHING = `{
  servers { id name displayName description enabled source transport env envMeta childUid installDir signedIn
    secrets { kind name workspaceId } workspaces { env args url } }
  serverSecrets { id kind name }
  workspaceServers { env args url server { name env } }
  registries { name url }
}`;

let db: TestDb;
let admin: UserCaller;
let user: UserCaller;
let asAdmin: TestClient;
let asUser: TestClient;

/**
 * Adds a server straight to the table, as installServer will.
 *
 * @param name - Its name.
 * @param [http] - Reached over HTTP rather than started.
 * @returns Its row.
 */
async function addServer(name: string, http = false) {
  const [row] = await db
    .insert(servers)
    .values({
      name,
      source: { type: SourceType.Manual },
      transport: http
        ? { type: TRANSPORT_STREAMABLE_HTTP, url: 'http://remote.example/mcp' }
        : { type: TRANSPORT_STDIO, command: 'node', args: ['server.js'] },
      env: { LOG_LEVEL: 'info' },
    })
    .returning();
  if (row === undefined) {
    throw new Error('no row');
  }
  return row;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
  admin = await createUser(db, 'admin@example.com', Role.Admin);
  user = await createUser(db, 'user@example.com');
  asAdmin = createClient(db, admin);
  asUser = createClient(db, user);
});

describe('servers', () => {
  it('each get a user id of their own from the child range, never handed out twice', async () => {
    const first = await addServer('one');
    const second = await addServer('two');
    expect(first.childUid).toBeGreaterThanOrEqual(10_000);
    expect(second.childUid).toBeGreaterThan(first.childUid);
    await db.delete(servers);
    const third = await addServer('three');
    expect(third.childUid).toBeGreaterThan(second.childUid);
  });

  it('may not be named ai-router, even straight in the table', async () => {
    await expect(addServer('ai-router')).rejects.toThrow();
  });

  it('are updated by any user, but not their user id, folder or source', async () => {
    const { id } = await addServer('git');
    const { updateServer } = await asUser.expectOk(UPDATE_SERVER, { id, set: { env: { A: '1' }, enabled: false } });
    expect(updateServer).toEqual({ id, name: 'git', env: { A: '1' }, enabled: false });
    for (const set of [{ childUid: 0 }, { installDir: '/' }, { name: 'ai-router' }, { env: { 'BAD NAME': 'x' } }]) {
      const { code } = await asUser.expectError(UPDATE_SERVER, { id, set });
      expect(code).toBeDefined();
    }
  });

  it('cannot be created or deleted by generated CRUD', async () => {
    for (const field of ['createServer', 'createServers', 'deleteServers']) {
      const { message } = await asAdmin.expectError(`mutation { ${field} { id } }`);
      expect(message).toContain(`Cannot query field "${field}"`);
    }
  });
});

describe('server secrets', () => {
  it('are set by an admin, served only by name, and cleared by null', async () => {
    const { id } = await addServer('actual');
    const set = await asAdmin.expectOk(SET_SECRET, {
      serverId: id,
      kind: 'env',
      name: 'ACTUAL_PASSWORD',
      value: SECRET,
    });
    expect(set.setServerSecret.secrets).toEqual([{ kind: 'env', name: 'ACTUAL_PASSWORD', workspaceId: null }]);
    await asAdmin.expectOk(SET_SECRET, { serverId: id, kind: 'env', name: 'ACTUAL_PASSWORD', value: null });
    const { servers: listed } = await asAdmin.expectOk('{ servers { secrets { name } } }');
    expect(listed).toEqual([{ secrets: [] }]);
  });

  it('are refused to a user who is not an admin', async () => {
    const { id } = await addServer('actual');
    const { code } = await asUser.expectError(SET_SECRET, { serverId: id, kind: 'env', name: 'A', value: SECRET });
    expect(code).toBe(ErrorCode.Forbidden);
  });

  it.each([
    ['an unknown kind', { kind: 'file', name: 'A' }],
    ['a bad env name', { kind: 'env', name: '1A' }],
    ['a bad header name', { kind: 'header', name: 'x y' }],
    ['a header value with a line break', { kind: 'header', name: 'x', value: 'a\r\nb: c' }],
  ])('refuses %s', async (_label, secret) => {
    const { id } = await addServer('actual');
    const { code } = await asAdmin.expectError(SET_SECRET, { serverId: id, value: SECRET, ...secret });
    expect(code).toBe(ErrorCode.BadUserInput);
  });

  it('never appear in any answer, and have no field to read them by', async () => {
    const { id } = await addServer('actual');
    const { id: remote } = await addServer('remote', true);
    const { workspaceId } = await createWorkspaceWithKey(db, 'household-a');
    await asAdmin.expectOk(SET_SECRET, { serverId: id, kind: 'env', name: 'PASSWORD', value: SECRET });
    await asAdmin.expectOk(SET_SECRET, { serverId: remote, kind: 'header', name: 'X-Key', value: `${SECRET}-h` });
    await asAdmin.expectOk(SET_SECRET, {
      serverId: id,
      workspaceId,
      kind: 'env',
      name: 'PASSWORD',
      value: `${SECRET}-w`,
    });
    await db.update(servers).set({ oauth: { tokens: { access_token: `${SECRET}-token` } } });
    await asUser.expectOk(CREATE_ENTRY, { values: { workspaceId, serverId: id, env: { BUDGET: 'a' } } });
    const answers = JSON.stringify([await asAdmin.expectOk(EVERYTHING), await asUser.expectOk(EVERYTHING)]);
    expect(answers).not.toContain(SECRET);
    expect(answers).toContain('"signedIn":true');
    expect((await asAdmin.expectError('{ serverSecrets { value } }')).message).toContain('Cannot query field "value"');
    expect((await asAdmin.expectError('{ servers { oauth } }')).message).toContain('Cannot query field "oauth"');
  });
});

describe('registries', () => {
  it('are added by any user, with an http address', async () => {
    const { createRegistry } = await asUser.expectOk(CREATE_REGISTRY, {
      values: { name: 'home', url: 'https://registry.home.arpa' },
    });
    expect(createRegistry).toMatchObject({ name: 'home' });
    const { code } = await asUser.expectError(CREATE_REGISTRY, { values: { name: 'x', url: 'file:///etc' } });
    expect(code).toBe(ErrorCode.BadUserInput);
  });
});

describe('a run resolving a server', () => {
  it('gets the server with its secrets, and a workspace entry merged over it', async () => {
    const { id } = await addServer('actual');
    const { workspaceId } = await createWorkspaceWithKey(db, 'household-a');
    const { workspaceId: plain } = await createWorkspaceWithKey(db, 'household-b');
    await asAdmin.expectOk(SET_SECRET, { serverId: id, kind: 'env', name: 'PASSWORD', value: 'base' });
    await asAdmin.expectOk(SET_SECRET, { serverId: id, workspaceId, kind: 'env', name: 'PASSWORD', value: 'a' });
    await asUser.expectOk(CREATE_ENTRY, { values: { workspaceId, serverId: id, args: ['--budget', 'a'] } });
    await asUser.expectOk(CREATE_ENTRY, { values: { workspaceId: plain, serverId: id } });
    const server = (await createSnapshotHost(db)).current().servers.get('actual');
    if (server === undefined) {
      throw new Error('not in the snapshot');
    }
    const base = resolveServer(server, null, TIMEOUTS);
    expect(base).toMatchObject({
      workspaceId: null,
      env: { LOG_LEVEL: 'info', PASSWORD: 'base' },
      idleTimeoutMs: 1000,
    });
    expect(resolveServer(server, workspaceId, TIMEOUTS)).toMatchObject({
      workspaceId,
      env: { LOG_LEVEL: 'info', PASSWORD: 'a' },
      transport: { args: ['--budget', 'a'] },
    });
    // An entry that changes nothing runs on the base instance.
    expect(resolveServer(server, plain, TIMEOUTS)).toEqual(base);
  });

  it('sees a secret as soon as it is set', async () => {
    const { id } = await addServer('remote', true);
    const snapshot = await createSnapshotHost(db);
    await createClient(db, admin, { snapshot }).expectOk(SET_SECRET, {
      serverId: id,
      kind: 'header',
      name: 'Authorization',
      value: 'Bearer x',
    });
    const server = snapshot.current().servers.get('remote');
    expect(server === undefined ? null : resolveServer(server, null, TIMEOUTS).transport).toEqual({
      type: TRANSPORT_STREAMABLE_HTTP,
      url: 'http://remote.example/mcp',
      headers: { Authorization: 'Bearer x' },
    });
  });
});
