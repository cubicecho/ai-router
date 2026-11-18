import { access, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserCaller } from '../../server/core/context.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { createSnapshotHost, type SnapshotHost } from '../../server/db/snapshot.ts';
import { activity } from '../../server/db/tables/activity.ts';
import { registries } from '../../server/db/tables/registries.ts';
import { Role } from '../../server/db/tables/users.ts';
import { ChildMode } from '../../server/tools/child-users.ts';
import { createToolServices, type ToolServiceParts } from '../../server/tools/services.ts';
import {
  closeTestDb,
  createClient,
  createTestDb,
  createUser,
  resetTestDb,
  type TestClient,
  type TestDb,
} from '../helpers.ts';
import { type HttpFixture, startHttpFixture } from './fixtures/http-server.ts';

/** The stdio fixture, run with this process's node. */
const FIXTURE = fileURLToPath(new URL('./fixtures/stdio-server.ts', import.meta.url));

const INSTALL = `mutation ($input: InstallServerInput!) {
  installServer(input: $input) { id name source transport childUid installDir login { signedIn } }
}`;
const TOOLS = 'query ($id: UUID!) { serverTools(id: $id) { name description } }';
const TRY = `mutation ($id: UUID!, $tool: String!, $arguments: JSON) {
  tryServerTool(id: $id, tool: $tool, arguments: $arguments)
}`;
const INSTANCES = '{ servers { id name instances { workspaceId state inFlight } } }';
const DELETE = 'mutation ($id: UUID!) { deleteServer(id: $id) }';
const BROWSE = `query ($registryId: UUID!, $search: String) {
  registryServers(registryId: $registryId, search: $search) {
    servers { name title choices { selector kind identifier version } } nextCursor
  }
}`;

let db: TestDb;
let root: string;
let http: HttpFixture;
let snapshot: SnapshotHost;
let tools: ToolServiceParts;
let user: UserCaller;
let asUser: TestClient;

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
});

afterAll(async () => {
  await http.close();
  await rm(root, { recursive: true, force: true });
  await closeTestDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  user = await createUser(db, 'user@example.com', Role.User);
  snapshot = await createSnapshotHost(db);
  const registryFetch = async (url: URL) =>
    Response.json({
      servers: [
        {
          server: {
            name: 'io.example/git',
            title: 'Git',
            version: '1.2.0',
            packages: [
              { registryType: 'npm', identifier: '@example/git-mcp', version: '1.2.0' },
              { registryType: 'oci', identifier: 'example/git' },
            ],
            remotes: [{ type: 'streamable-http', url: 'https://git.example/mcp' }],
          },
        },
      ],
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
    expect(servers).toEqual([
      { id: server.id, name: 'fixture', instances: [{ workspaceId: null, state: 'ready', inFlight: 0 }] },
    ]);
    const { message } = await asUser.expectError('{ servers { name instances { state } } }');
    expect(message).toContain("Select the server's id");
  });

  it('runs in its own folder, with nothing of the router in its env', async () => {
    const server = await addFixture();
    const { tryServerTool } = await asUser.expectOk(TRY, { id: server.id, tool: 'cwd' });
    expect(tryServerTool.content[0].text).toBe(path.join(root, server.installDir));
    const env = JSON.parse((await asUser.expectOk(TRY, { id: server.id, tool: 'env' })).tryServerTool.content[0].text);
    expect(env.HOME).toBe(path.join(root, server.installDir));
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
          ],
        },
      ],
      nextCursor: 'next',
    });
  });
});
