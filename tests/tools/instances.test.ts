import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CHILD_DEFAULTS } from '../../server/core/defaults.ts';
import { type ChildIsolation, ChildMode } from '../../server/tools/child-users.ts';
import { InstanceError, InstanceErrorCode, InstanceState } from '../../server/tools/instance.ts';
import { InstanceManager, serverFingerprint } from '../../server/tools/instances.ts';
import { type ResolvedServer, TRANSPORT_STDIO, TRANSPORT_STREAMABLE_HTTP } from '../../server/tools/shapes.ts';
import { type HttpFixture, startHttpFixture } from './fixtures/http-server.ts';

/** The stdio fixture, run with this process's node. */
const FIXTURE = fileURLToPath(new URL('./fixtures/stdio-server.ts', import.meta.url));

/** Runs children as the router's own user, as on a laptop without the helper. */
const SHARED: ChildIsolation = { mode: ChildMode.Shared, reason: '' };

let installDir: string;
let http: HttpFixture;
let manager: InstanceManager;

beforeAll(async () => {
  installDir = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-router-instances-')));
  await mkdir(path.join(installDir, 'tmp'));
  http = await startHttpFixture();
});

afterEach(async () => {
  await manager.stopAll();
});

afterAll(async () => {
  await http.close();
  await rm(installDir, { recursive: true, force: true });
});

/**
 * Describes the stdio fixture as a resolved server.
 *
 * @param [overrides] - Fields that differ.
 * @returns The server.
 */
function stdioServer(overrides: Partial<ResolvedServer> = {}): ResolvedServer {
  return {
    id: 'server-1',
    name: 'fixture',
    workspaceId: null,
    transport: { type: TRANSPORT_STDIO, command: process.execPath, args: [FIXTURE] },
    env: { FIXTURE_GREETING: 'hello' },
    childUid: CHILD_DEFAULTS.uidMin,
    installDir,
    idleTimeoutMs: 60_000,
    callTimeoutMs: 10_000,
    ...overrides,
  };
}

/**
 * Describes the HTTP fixture as a resolved server.
 *
 * @returns The server.
 */
function httpServer(): ResolvedServer {
  return {
    id: 'server-2',
    name: 'remote',
    workspaceId: null,
    transport: { type: TRANSPORT_STREAMABLE_HTTP, url: http.url, headers: {} },
    env: {},
    childUid: null,
    installDir: null,
    idleTimeoutMs: 60_000,
    callTimeoutMs: 10_000,
  };
}

/**
 * Reads a result's first text block.
 *
 * @param result - A tool result.
 * @returns Its text.
 */
function textOf(result: CallToolResult): string {
  const [block] = result.content;
  return block?.type === 'text' ? block.text : '';
}

/**
 * Asks the fixture behind a server for its pid.
 *
 * @param server - The server.
 * @returns The pid, as text.
 */
async function pidOf(server: ResolvedServer): Promise<string> {
  return textOf(await manager.callTool(server, 'pid', {}));
}

describe('InstanceManager', () => {
  it('starts an instance once and reuses it', async () => {
    manager = new InstanceManager({ isolation: SHARED });
    const instance = await manager.get(stdioServer());
    expect(instance.state).toBe(InstanceState.Ready);
    expect(await manager.get(stdioServer())).toBe(instance);
    expect(await pidOf(stdioServer())).toBe(await pidOf(stdioServer()));
  });

  it('keeps a workspace instance apart from the base instance', async () => {
    manager = new InstanceManager({ isolation: SHARED });
    const base = stdioServer();
    const workspace = stdioServer({ workspaceId: 'workspace-1', env: { FIXTURE_GREETING: 'hi' } });
    expect(await pidOf(base)).not.toBe(await pidOf(workspace));
  });

  it('restarts an instance whose settings changed, after its calls finish', async () => {
    manager = new InstanceManager({ isolation: SHARED });
    const before = stdioServer();
    const old = manager.instanceFor(before);
    const oldPid = await pidOf(before);
    // Long enough to outlast starting the new program, which can take a second on a busy machine.
    const slow = manager.callTool(before, 'sleep', { ms: 3000 });

    const after = stdioServer({ env: { FIXTURE_GREETING: 'changed' } });
    expect(serverFingerprint(after)).not.toBe(serverFingerprint(before));
    expect(await pidOf(after)).not.toBe(oldPid);
    expect(old.state).toBe(InstanceState.Ready);

    expect(textOf(await slow)).toBe('slept');
    await vi.waitFor(() => expect(old.state).toBe(InstanceState.Stopped));
  });

  it('takes the same settings in any key order as unchanged', () => {
    const server = stdioServer({ env: { A: '1', B: '2' } });
    expect(serverFingerprint(server)).toBe(serverFingerprint({ ...server, env: { B: '2', A: '1' } }));
  });

  it('refuses stdio servers, with the reason, when isolation is refused, and still reaches HTTP ones', async () => {
    manager = new InstanceManager({ isolation: { mode: ChildMode.Refused, reason: 'no helper here' } });
    const error = await manager.callTool(stdioServer(), 'pid', {}).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InstanceError);
    expect(error).toMatchObject({
      code: InstanceErrorCode.Refused,
      message: expect.stringContaining('no helper here'),
    });
    expect((await manager.listTools(httpServer())).map((tool) => tool.name)).toEqual(['header']);
  });

  it('hands each HTTP instance the login its lookup finds, and reports every call', async () => {
    const authProviderFor = vi.fn(() => undefined);
    const onCall = vi.fn();
    manager = new InstanceManager({ isolation: SHARED, authProviderFor, onCall });
    await manager.callTool(httpServer(), 'header', {});
    expect(authProviderFor).toHaveBeenCalledWith(httpServer());
    expect(onCall).toHaveBeenCalledWith(expect.objectContaining({ serverId: 'server-2', tool: 'header', ok: true }));
  });

  it('forgets every instance of one server', async () => {
    manager = new InstanceManager({ isolation: SHARED });
    const base = await manager.get(stdioServer());
    const workspace = await manager.get(stdioServer({ workspaceId: 'workspace-1', env: {} }));
    const other = await manager.get(httpServer());
    await manager.forget('server-1');
    expect(base.state).toBe(InstanceState.Stopped);
    expect(workspace.state).toBe(InstanceState.Stopped);
    expect(other.state).toBe(InstanceState.Ready);
    expect(manager.instanceFor(stdioServer())).not.toBe(base);
  });

  it('stops everything for shutdown', async () => {
    manager = new InstanceManager({ isolation: SHARED });
    const stdio = await manager.get(stdioServer());
    const remote = await manager.get(httpServer());
    await manager.stopAll();
    expect(stdio.state).toBe(InstanceState.Stopped);
    expect(remote.state).toBe(InstanceState.Stopped);
  });
});
