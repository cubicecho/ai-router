import { access, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserCaller } from '../../server/core/context.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { createSnapshotHost, type SnapshotHost } from '../../server/db/snapshot.ts';
import { activity } from '../../server/db/tables/activity.ts';
import { registries } from '../../server/db/tables/registries.ts';
import { serverSecrets } from '../../server/db/tables/server-secrets.ts';
import { servers } from '../../server/db/tables/servers.ts';
import { Role } from '../../server/db/tables/users.ts';
import { workspaceServers } from '../../server/db/tables/workspace-servers.ts';
import { ChildMode } from '../../server/tools/child-users.ts';
import { homeOf } from '../../server/tools/install-folder.ts';
import { createToolServices, type ToolServiceParts } from '../../server/tools/services.ts';
import { RESERVED_SERVER_NAME } from '../../server/tools/shapes.ts';
import {
  closeTestDb,
  createClient,
  createTestDb,
  createUser,
  createWorkspaceWithKey,
  freeGroups,
  resetTestDb,
  type TestClient,
  type TestDb,
} from '../helpers.ts';
import {
  FIXTURE_HEADER,
  type HttpFixture,
  type SseFixture,
  startHttpFixture,
  startSseFixture,
} from './fixtures/http-server.ts';

/** The stdio fixture, run with this process's node. */
const FIXTURE = fileURLToPath(new URL('./fixtures/stdio-server.ts', import.meta.url));

const INSTALL = `mutation ($input: InstallServerInput!) {
  installServer(input: $input) { id name source transport childUid installDir login { signedIn } }
}`;
const TOOLS = 'query ($id: UUID!) { serverTools(id: $id) { name description } }';
const TRY = `mutation ($id: UUID!, $tool: String!, $arguments: JSON) {
  tryServerTool(id: $id, tool: $tool, arguments: $arguments)
}`;
const TRY_IN = `mutation ($id: UUID!, $workspaceId: UUID, $tool: String!, $arguments: JSON) {
  tryServerTool(id: $id, workspaceId: $workspaceId, tool: $tool, arguments: $arguments)
}`;
const INSTANCES = '{ servers { id name instances { workspaceId state inFlight } } }';
const DELETE = 'mutation ($id: UUID!) { deleteServer(id: $id) }';
const CREATE_ENTRY = `mutation ($values: CreateWorkspaceServerInput!) {
  createWorkspaceServer(values: $values) { id childUid }
}`;
const DELETE_ENTRY = 'mutation ($id: UUID!) { deleteWorkspaceServer(where: { id: { eq: $id } }) { id } }';
const DELETE_WORKSPACE = 'mutation ($id: UUID!) { deleteWorkspace(where: { id: { eq: $id } }) { id } }';
const SET_GROUPS = `mutation ($id: UUID!, $extraGroups: [Int!]!) {
  updateServer(where: { id: { eq: $id } }, set: { extraGroups: $extraGroups }) { id }
}`;
/** Everything a person can read about servers and their secrets, to scan for a planted value. */
const EVERYTHING = `{
  servers { id name source transport env envMeta installDir login { signedIn } secrets { kind name workspaceId } }
  serverSecrets { id kind name }
}`;
/** A header value planted to be looked for in every answer. */
const SECRET = 'planted-header-value';
/** The mode bits a test compares. */
const MODE_BITS = 0o7777;
const BROWSE = `query ($registryId: UUID!, $search: String) {
  registryServers(registryId: $registryId, search: $search) {
    servers { name title choices { selector kind identifier version } } nextCursor
  }
}`;

let db: TestDb;
let root: string;
let http: HttpFixture;
let sse: SseFixture;
let snapshot: SnapshotHost;
let tools: ToolServiceParts;
let user: UserCaller;
let asUser: TestClient;
let asAdmin: TestClient;

/**
 * Adds the stdio fixture by hand, as a person would.
 *
 * @param name - Its name.
 * @returns What installServer answered.
 */
async function addFixture(name = 'fixture') {
  const { installServer } = await asUser.expectOk(INSTALL, {
    input: {
      name,
      source: { type: 'manual' },
      transport: { type: 'stdio', command: process.execPath, args: [FIXTURE] },
    },
  });
  return installServer;
}

beforeAll(async () => {
  db = await createTestDb();
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-router-services-')));
  http = await startHttpFixture();
  sse = await startSseFixture();
});

afterAll(async () => {
  await http.close();
  await sse.close();
  await rm(root, { recursive: true, force: true });
  await closeTestDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  user = await createUser(db, 'user@example.com', Role.User);
  snapshot = await createSnapshotHost(db);
  const gitEntry = {
    server: {
      name: 'io.example/git',
      title: 'Git',
      version: '1.2.0',
      packages: [
        { registryType: 'npm', identifier: '@example/git-mcp', version: '1.2.0' },
        { registryType: 'oci', identifier: 'example/git' },
      ],
      remotes: [
        { type: 'streamable-http', url: 'https://git.example/mcp' },
        {
          type: 'sse',
          url: 'https://git.example/sse',
          headers: [
            { name: 'Authorization', value: 'declared' },
            { name: 'X-Fixed', value: 'yes' },
          ],
        },
      ],
    },
  };
  // The one entry, by name, or a search that finds it.
  const registryFetch = async (url: URL) =>
    url.pathname.endsWith('/versions/latest')
      ? Response.json(gitEntry)
      : Response.json({
          servers: [gitEntry],
          metadata: { nextCursor: url.searchParams.get('search') === 'git' ? 'next' : undefined },
        });
  tools = createToolServices({
    db,
    snapshot,
    isolation: { mode: ChildMode.Shared, reason: '' },
    registryFetch,
    folders: { root },
  });
  asUser = createClient(db, user, { snapshot, tools });
  asAdmin = createClient(db, await createUser(db, 'admin@example.com', Role.Admin), { snapshot, tools });
});

afterEach(async () => {
  await tools.stop();
});

describe('a server added by hand', () => {
  it('gets its own user id and folder, lists its tools, and runs them', async () => {
    const server = await addFixture();
    expect(server).toMatchObject({ name: 'fixture', source: { type: 'manual' }, login: null });
    expect(server.installDir).toMatch(new RegExp(`^${server.childUid}-[0-9a-f]{16}$`));
    await access(path.join(root, server.installDir));

    const { serverTools } = await asUser.expectOk(TOOLS, { id: server.id });
    expect(serverTools.map((tool: { name: string }) => tool.name)).toContain('echo');

    const { tryServerTool } = await asUser.expectOk(TRY, { id: server.id, tool: 'echo', arguments: { text: 'hi' } });
    expect(tryServerTool).toMatchObject({ content: [{ type: 'text', text: 'hi' }] });

    const { servers } = await asUser.expectOk(INSTANCES);
    // The admin server is on every router, and this test is not about it.
    expect(servers.filter((listed: { name: string }) => listed.name !== RESERVED_SERVER_NAME)).toEqual([
      { id: server.id, name: 'fixture', instances: [{ workspaceId: null, state: 'ready', inFlight: 0 }] },
    ]);
    const { message } = await asUser.expectError('{ servers { name instances { state } } }');
    expect(message).toContain("Select the server's id");
  });

  it('runs in its own folder, with its HOME inside, and nothing of the router in its env', async () => {
    const server = await addFixture();
    const { tryServerTool } = await asUser.expectOk(TRY, { id: server.id, tool: 'cwd' });
    expect(tryServerTool.content[0].text).toBe(path.join(root, server.installDir));
    const env = JSON.parse((await asUser.expectOk(TRY, { id: server.id, tool: 'env' })).tryServerTool.content[0].text);
    expect(env.HOME).toBe(homeOf(path.join(root, server.installDir)));
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('BETTER_AUTH_SECRET');
  });

  it('records every call in the activity, failures with why', async () => {
    const server = await addFixture();
    await asUser.expectOk(TRY, { id: server.id, tool: 'echo', arguments: { text: 'hi' } });
    await asUser.expectOk(TRY, { id: server.id, tool: 'fail' });
    await tools.activity.flush();
    const rows = await db.select().from(activity);
    expect(rows.map((row) => [row.serverName, row.tool, row.ok]).sort()).toEqual([
      ['fixture', 'echo', true],
      ['fixture', 'fail', false],
    ]);
  });

  it('refuses arguments that are not an object', async () => {
    const server = await addFixture();
    const { code } = await asUser.expectError(TRY, { id: server.id, tool: 'echo', arguments: ['hi'] });
    expect(code).toBe(ErrorCode.BadUserInput);
  });

  it('needs a name', async () => {
    const { code } = await asUser.expectError(INSTALL, {
      input: { source: { type: 'manual' }, transport: { type: 'stdio', command: 'node' } },
    });
    expect(code).toBe(ErrorCode.BadUserInput);
  });

  it.each(['ai-router', 'a__b', 'trailing_'])('may not be named %s', async (name) => {
    const { code } = await asUser.expectError(INSTALL, {
      input: { name, source: { type: 'manual' }, transport: { type: 'stdio', command: 'node' } },
    });
    expect(code).toBe(ErrorCode.BadUserInput);
  });

  it('is refused a name already taken, before anything is made', async () => {
    await addFixture();
    const before = await readdir(root);
    const { code } = await asUser.expectError(INSTALL, {
      input: { name: 'fixture', source: { type: 'manual' }, transport: { type: 'stdio', command: 'node' } },
    });
    expect(code).toBe(ErrorCode.BadUserInput);
    expect(await readdir(root)).toEqual(before);
  });

  it('is stopped, and its folder removed, when it is deleted', async () => {
    const server = await addFixture();
    await asUser.expectOk(TOOLS, { id: server.id });
    expect(await asUser.expectOk(DELETE, { id: server.id })).toEqual({ deleteServer: true });
    expect(tools.instances.list(server.id)).toEqual([]);
    await expect(access(path.join(root, server.installDir))).rejects.toThrow();
    expect((await asUser.expectError(DELETE, { id: server.id })).code).toBe(ErrorCode.NotFound);
  });

  it('is refused while turned off', async () => {
    const server = await addFixture();
    await asUser.expectOk(
      'mutation ($id: UUID!) { updateServer(where: { id: { eq: $id } }, set: { enabled: false }) { id } }',
      {
        id: server.id,
      },
    );
    expect((await asUser.expectError(TOOLS, { id: server.id })).code).toBe(ErrorCode.BadUserInput);
  });
});

describe('a workspace instance', () => {
  /**
   * Adds the fixture and a workspace whose entry for it overrides its env.
   *
   * @returns The server, the workspace and the entry.
   */
  async function addEntry() {
    const server = await addFixture();
    const { workspaceId } = await createWorkspaceWithKey(db, 'household-a');
    const { createWorkspaceServer: entry } = await asUser.expectOk(CREATE_ENTRY, {
      values: { workspaceId, serverId: server.id, env: { FIXTURE_GREETING: 'household a' } },
    });
    return { server, workspaceId, entry };
  }

  /**
   * Reads an entry's folder, as the router recorded it.
   *
   * @param entryId - The entry.
   * @returns Its folder's name, or null.
   */
  async function entryFolder(entryId: string): Promise<string | null> {
    const [row] = await db.select().from(workspaceServers).where(eq(workspaceServers.id, entryId));
    return row?.installDir ?? null;
  }

  it('runs as the entry’s own uid, in the server’s folder, with a HOME of its own made on first use', async () => {
    const { server, workspaceId, entry } = await addEntry();
    expect(entry.childUid).toBeGreaterThan(server.childUid);
    expect(await entryFolder(entry.id)).toBeNull();

    const cwd = await asUser.expectOk(TRY_IN, { id: server.id, workspaceId, tool: 'cwd' });
    expect(cwd.tryServerTool.content[0].text).toBe(path.join(root, server.installDir));
    const folder = await entryFolder(entry.id);
    expect(folder).toMatch(new RegExp(`^${entry.childUid}-[0-9a-f]{16}$`));
    const { tryServerTool } = await asUser.expectOk(TRY_IN, { id: server.id, workspaceId, tool: 'env' });
    const env = JSON.parse(tryServerTool.content[0].text);
    expect(env).toMatchObject({ HOME: homeOf(path.join(root, folder ?? '')), FIXTURE_GREETING: 'household a' });
    expect((await stat(path.join(root, folder ?? ''))).mode & MODE_BITS).toBe(0o700);

    const { servers } = await asUser.expectOk(INSTANCES);
    const listed = servers.find((candidate: { id: string }) => candidate.id === server.id);
    expect(listed.instances).toEqual([{ workspaceId, state: 'ready', inFlight: 0 }]);
  });

  it('makes one folder however many first calls arrive at once', async () => {
    const { server, workspaceId, entry } = await addEntry();
    await Promise.all(
      [1, 2, 3].map(() =>
        asUser.expectOk(TRY_IN, { id: server.id, workspaceId, tool: 'echo', arguments: { text: 'x' } }),
      ),
    );
    expect((await readdir(root)).filter((name) => name.startsWith(`${entry.childUid}-`))).toEqual([
      await entryFolder(entry.id),
    ]);
  });

  it('is stopped and its folder removed when its entry is deleted', async () => {
    const { server, workspaceId, entry } = await addEntry();
    await asUser.expectOk(TRY_IN, { id: server.id, workspaceId, tool: 'cwd' });
    const folder = path.join(root, (await entryFolder(entry.id)) ?? '');
    await asUser.expectOk(DELETE_ENTRY, { id: entry.id });
    expect(tools.instances.list(server.id).map((instance) => instance.server.workspaceId)).toEqual([]);
    await expect(access(folder)).rejects.toThrow();
    await access(path.join(root, server.installDir));
  });

  it('has its folder removed when its workspace is deleted', async () => {
    const { server, workspaceId, entry } = await addEntry();
    await asUser.expectOk(TRY_IN, { id: server.id, workspaceId, tool: 'cwd' });
    const folder = path.join(root, (await entryFolder(entry.id)) ?? '');
    await asUser.expectOk(DELETE_WORKSPACE, { id: workspaceId });
    await expect(access(folder)).rejects.toThrow();
  });

  it('has its folder removed with its server', async () => {
    const { server, workspaceId, entry } = await addEntry();
    await asUser.expectOk(TRY_IN, { id: server.id, workspaceId, tool: 'cwd' });
    const folder = path.join(root, (await entryFolder(entry.id)) ?? '');
    await asUser.expectOk(DELETE, { id: server.id });
    await expect(access(folder)).rejects.toThrow();
    await expect(access(path.join(root, server.installDir))).rejects.toThrow();
  });

  it('is replaced when its server’s extra groups change', async () => {
    const { server, workspaceId } = await addEntry();
    await asUser.expectOk(TRY_IN, { id: server.id, workspaceId, tool: 'cwd' });
    const [before] = tools.instances.list(server.id);
    await asAdmin.expectOk(SET_GROUPS, { id: server.id, extraGroups: freeGroups(1) });
    await asUser.expectOk(TRY_IN, { id: server.id, workspaceId, tool: 'cwd' });
    const [after] = tools.instances.list(server.id);
    expect(after).not.toBe(before);
    expect(after?.server.runAs?.groups).toEqual(freeGroups(1));
  });
});

describe('a remote server', () => {
  it('has no folder, and lists its tools over HTTP', async () => {
    const { installServer } = await asUser.expectOk(INSTALL, {
      input: { name: 'remote', source: { type: 'manual' }, transport: { type: 'streamable-http', url: http.url } },
    });
    expect(installServer).toMatchObject({ installDir: null, login: { signedIn: false } });
    expect((await readdir(root)).filter((name) => name.startsWith(`${installServer.childUid}-`))).toEqual([]);
    const { serverTools } = await asUser.expectOk(TOOLS, { id: installServer.id });
    expect(serverTools.length).toBeGreaterThan(0);
  });
});

describe('a registry', () => {
  it('is browsed for what each server can be installed as', async () => {
    const [registry] = await db
      .insert(registries)
      .values({ name: 'home', url: 'https://registry.home.arpa' })
      .returning();
    const { registryServers } = await asUser.expectOk(BROWSE, { registryId: registry?.id, search: 'git' });
    expect(registryServers).toEqual({
      servers: [
        {
          name: 'io.example/git',
          title: 'Git',
          choices: [
            { selector: '0', kind: 'npm', identifier: '@example/git-mcp', version: '1.2.0' },
            { selector: 'remote:0', kind: 'streamable-http', identifier: 'https://git.example/mcp', version: null },
            { selector: 'remote:1', kind: 'sse', identifier: 'https://git.example/sse', version: null },
          ],
        },
      ],
      nextCursor: 'next',
    });
  });
});

/**
 * Reads the secret headers stored for a server.
 *
 * @param serverId - The server.
 * @returns Each header's name and value, by name.
 */
async function storedHeaders(serverId: string) {
  const rows = await db
    .select({ kind: serverSecrets.kind, name: serverSecrets.name, value: serverSecrets.value })
    .from(serverSecrets)
    .where(eq(serverSecrets.serverId, serverId));
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

describe('headers a server is added with', () => {
  it('are kept as its secrets, sent to it, and never served', async () => {
    const { installServer } = await asAdmin.expectOk(INSTALL, {
      input: {
        name: 'remote',
        source: { type: 'manual' },
        transport: { type: 'streamable-http', url: http.url },
        headers: [{ name: FIXTURE_HEADER, value: SECRET }],
      },
    });
    expect(await storedHeaders(installServer.id)).toEqual([{ kind: 'header', name: FIXTURE_HEADER, value: SECRET }]);
    const { tryServerTool } = await asAdmin.expectOk(TRY, { id: installServer.id, tool: 'header' });
    expect(tryServerTool).toMatchObject({ content: [{ type: 'text', text: SECRET }] });
    const everything = await asAdmin.expectOk(EVERYTHING);
    expect(everything.servers.find((server: { id: string }) => server.id === installServer.id).secrets).toEqual([
      { kind: 'header', name: FIXTURE_HEADER, workspaceId: null },
    ]);
    expect(JSON.stringify([installServer, everything])).not.toContain(SECRET);
  });

  it('are refused to a user who is not an admin, and nothing is added', async () => {
    const { code } = await asUser.expectError(INSTALL, {
      input: {
        name: 'remote',
        source: { type: 'manual' },
        transport: { type: 'streamable-http', url: http.url },
        headers: [{ name: 'Authorization', value: SECRET }],
      },
    });
    expect(code).toBe(ErrorCode.Forbidden);
    expect(await db.select().from(servers).where(eq(servers.name, 'remote'))).toEqual([]);
  });

  it('are refused for a program, whose folder is removed again', async () => {
    const before = await readdir(root);
    const { code } = await asAdmin.expectError(INSTALL, {
      input: {
        name: 'fixture',
        source: { type: 'manual' },
        transport: { type: 'stdio', command: process.execPath, args: [FIXTURE] },
        headers: [{ name: 'Authorization', value: SECRET }],
      },
    });
    expect(code).toBe(ErrorCode.BadUserInput);
    expect(await db.select().from(servers).where(eq(servers.name, 'fixture'))).toEqual([]);
    expect(await readdir(root)).toEqual(before);
  });

  it.each([
    ['a bad name', [{ name: 'x y', value: SECRET }]],
    ['a value with a line break', [{ name: 'X-Token', value: 'a\r\nb: c' }]],
    ['an empty value', [{ name: 'X-Token', value: '' }]],
    [
      'a name given twice in another case',
      [
        { name: 'Authorization', value: SECRET },
        { name: 'authorization', value: SECRET },
      ],
    ],
  ])('refuses %s', async (_label, headers) => {
    const { code } = await asAdmin.expectError(INSTALL, {
      input: {
        name: 'remote',
        source: { type: 'manual' },
        transport: { type: 'streamable-http', url: http.url },
        headers,
      },
    });
    expect(code).toBe(ErrorCode.BadUserInput);
  });
});

describe('an SSE server', () => {
  it('is added by hand with its headers, has no folder but a login, and runs its tools', async () => {
    const { installServer } = await asAdmin.expectOk(INSTALL, {
      input: {
        name: 'legacy',
        source: { type: 'manual' },
        transport: { type: 'sse', url: sse.url },
        headers: [{ name: FIXTURE_HEADER, value: 'over-sse' }],
      },
    });
    expect(installServer).toMatchObject({
      transport: { type: 'sse', url: sse.url },
      installDir: null,
      login: { signedIn: false },
    });
    expect((await readdir(root)).filter((name) => name.startsWith(`${installServer.childUid}-`))).toEqual([]);
    const { serverTools } = await asAdmin.expectOk(TOOLS, { id: installServer.id });
    expect(serverTools.map((tool: { name: string }) => tool.name)).toEqual(['header']);
    const { tryServerTool } = await asAdmin.expectOk(TRY, { id: installServer.id, tool: 'header' });
    expect(tryServerTool).toMatchObject({ content: [{ type: 'text', text: 'over-sse' }] });
    expect(sse.streamHeader()).toBe('over-sse');
  });

  it('is installed from a registry remote, with the headers it declares under the ones it is given', async () => {
    await db.insert(registries).values({ name: 'home', url: 'https://registry.home.arpa' });
    const { installServer } = await asAdmin.expectOk(INSTALL, {
      input: {
        source: { type: 'registry', registry: 'home', serverName: 'io.example/git' },
        packageSelector: 'remote:1',
        headers: [{ name: 'authorization', value: SECRET }],
      },
    });
    expect(installServer).toMatchObject({ name: 'git', transport: { type: 'sse', url: 'https://git.example/sse' } });
    expect(installServer.installDir).toBeNull();
    expect(await storedHeaders(installServer.id)).toEqual([
      { kind: 'header', name: 'authorization', value: SECRET },
      { kind: 'header', name: 'X-Fixed', value: 'yes' },
    ]);
  });
});
