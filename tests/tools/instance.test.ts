import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CHILD_DEFAULTS } from '../../server/core/defaults.ts';
import { type ChildIsolation, ChildMode, serverChildUser } from '../../server/tools/child-users.ts';
import { type ChildExec, childEnv, execChild, homeOf } from '../../server/tools/install-folder.ts';
import {
  Instance,
  InstanceError,
  InstanceErrorCode,
  InstanceState,
  type ToolCallEvent,
} from '../../server/tools/instance.ts';
import {
  type ResolvedServer,
  TRANSPORT_SSE,
  TRANSPORT_STDIO,
  TRANSPORT_STREAMABLE_HTTP,
} from '../../server/tools/shapes.ts';
import {
  FIXTURE_HEADER,
  type HttpFixture,
  type SseFixture,
  startHttpFixture,
  startSseFixture,
} from './fixtures/http-server.ts';

/** The stdio fixture, run with this process's node. */
const FIXTURE = fileURLToPath(new URL('./fixtures/stdio-server.ts', import.meta.url));

/** Runs children as the router's own user, as on a laptop without the helper. */
const SHARED: ChildIsolation = { mode: ChildMode.Shared, reason: '' };

/** Runs children through the helper, which the tests stand a fake in for. */
const ISOLATED: ChildIsolation = { mode: ChildMode.Isolated, reason: '' };

let installDir: string;
let helperDir: string;
let helperPath: string;
let http: HttpFixture;
let sse: SseFixture;
const running: Instance[] = [];

beforeAll(async () => {
  installDir = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-router-instance-')));
  await mkdir(path.join(homeOf(installDir), 'tmp'), { recursive: true });
  helperDir = await mkdtemp(path.join(tmpdir(), 'ai-router-helper-'));
  helperPath = path.join(helperDir, 'run-as-child');
  // Runs the command after `--` without switching users: what the real helper does, minus setuid.
  await writeFile(helperPath, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
  await chmod(helperPath, 0o755);
  http = await startHttpFixture();
  sse = await startSseFixture();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((instance) => instance.stop()));
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await http.close();
  await sse.close();
  await rm(installDir, { recursive: true, force: true });
  await rm(helperDir, { recursive: true, force: true });
});

/**
 * Whether a process is still running.
 *
 * @param pid - The process.
 * @returns true when signal 0 reaches it.
 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Describes the stdio fixture as a resolved server.
 *
 * @param [overrides] - Fields that differ.
 * @param [args] - Extra arguments for the fixture.
 * @returns The server.
 */
function stdioServer(overrides: Partial<ResolvedServer> = {}, args: string[] = []): ResolvedServer {
  return {
    id: 'server-1',
    name: 'fixture',
    workspaceId: null,
    transport: { type: TRANSPORT_STDIO, command: process.execPath, args: [FIXTURE, ...args] },
    env: { FIXTURE_GREETING: 'hello' },
    runAs: serverChildUser(CHILD_DEFAULTS.uidMin),
    installDir,
    homeDir: homeOf(installDir),
    idleTimeoutMs: 60_000,
    callTimeoutMs: 10_000,
    ...overrides,
  };
}

/**
 * Describes the HTTP fixture as a resolved server.
 *
 * @param [headers] - Headers to send.
 * @returns The server.
 */
function httpServer(headers: Record<string, string> = {}): ResolvedServer {
  return {
    id: 'server-2',
    name: 'remote',
    workspaceId: 'workspace-1',
    transport: { type: TRANSPORT_STREAMABLE_HTTP, url: http.url, headers },
    env: {},
    runAs: null,
    installDir: null,
    homeDir: null,
    idleTimeoutMs: 60_000,
    callTimeoutMs: 10_000,
  };
}

/**
 * Describes the SSE fixture as a resolved server.
 *
 * @param [headers] - Headers to send.
 * @returns The server.
 */
function sseServer(headers: Record<string, string> = {}): ResolvedServer {
  return {
    ...httpServer(),
    id: 'server-3',
    name: 'legacy',
    transport: { type: TRANSPORT_SSE, url: sse.url, headers },
  };
}

/**
 * Builds an instance that the tests stop afterwards.
 *
 * @param server - The server.
 * @param [onCall] - The call hook.
 * @param [overrides] - Instance settings.
 * @param [isolation] - The isolation mode.
 * @returns The instance.
 */
function track(
  server: ResolvedServer,
  onCall?: (event: ToolCallEvent) => void,
  overrides = {},
  isolation: ChildIsolation = SHARED,
): Instance {
  const instance = new Instance(server, { isolation, onCall }, overrides);
  running.push(instance);
  return instance;
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
 * Catches what a promise rejects with.
 *
 * @param promise - The promise.
 * @returns The rejection, which must be an InstanceError.
 */
async function instanceErrorOf(promise: Promise<unknown>): Promise<InstanceError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(InstanceError);
  if (error instanceof InstanceError) {
    return error;
  }
  throw new Error('no InstanceError');
}

describe('a stdio instance', () => {
  it('starts on its first call, lists its tools and calls one', async () => {
    const events: ToolCallEvent[] = [];
    const instance = track(stdioServer(), (event) => events.push(event));
    expect(instance.state).toBe(InstanceState.Stopped);

    const tools = await instance.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['echo', 'pid', 'env', 'sleep']));
    expect(instance.state).toBe(InstanceState.Ready);

    const result = await instance.callTool('echo', { text: 'hi' });
    expect(textOf(result)).toBe('hi');
    expect(events).toEqual([
      { serverId: 'server-1', workspaceId: null, tool: 'echo', ms: expect.any(Number), ok: true },
    ]);
  });

  it('reports a tool that answers with isError as a failed call', async () => {
    const events: ToolCallEvent[] = [];
    const instance = track(stdioServer(), (event) => events.push(event));
    const result = await instance.callTool('fail', {});
    expect(result.isError).toBe(true);
    expect(events[0]).toMatchObject({ tool: 'fail', ok: false, error: 'it went wrong' });
  });

  it('times a call out and stays ready', async () => {
    const events: ToolCallEvent[] = [];
    const instance = track(stdioServer(), (event) => events.push(event));
    const error = await instanceErrorOf(instance.callTool('sleep', { ms: 2_000 }, { timeoutMs: 100 }));
    expect(error.code).toBe(InstanceErrorCode.TimedOut);
    expect(events[0]).toMatchObject({ tool: 'sleep', ok: false });
    expect(instance.state).toBe(InstanceState.Ready);
    expect(textOf(await instance.callTool('echo', { text: 'still here' }))).toBe('still here');
  });

  it('never lengthens the server’s own call timeout', async () => {
    const instance = track(stdioServer({ callTimeoutMs: 100 }));
    const error = await instanceErrorOf(instance.callTool('sleep', { ms: 2_000 }, { timeoutMs: 5_000 }));
    expect(error.code).toBe(InstanceErrorCode.TimedOut);
  });

  it('fails when its program exits, backs off, then starts again', async () => {
    const instance = track(stdioServer(), undefined, { firstBackoffMs: 300 });
    const firstPid = textOf(await instance.callTool('pid', {}));

    const crash = await instanceErrorOf(instance.callTool('crash', {}));
    expect(crash.code).toBe(InstanceErrorCode.Closed);
    expect(crash.message).toContain('fixture crashed on purpose');
    expect(instance.state).toBe(InstanceState.Failed);
    expect(instance.error).toContain('fixture crashed on purpose');

    const backedOff = await instanceErrorOf(instance.callTool('pid', {}));
    expect(backedOff.code).toBe(InstanceErrorCode.BackedOff);
    expect(backedOff.retryAt).toBeGreaterThan(Date.now());

    await delay(350);
    const secondPid = textOf(await instance.callTool('pid', {}));
    expect(secondPid).not.toBe(firstPid);
    expect(instance.state).toBe(InstanceState.Ready);
    expect(instance.error).toBe('');
  });

  it('keeps what a program that would not start wrote to stderr', async () => {
    const instance = track(stdioServer({}, ['--die-at-start']));
    const error = await instanceErrorOf(instance.start());
    expect(error.code).toBe(InstanceErrorCode.StartFailed);
    expect(error.detail).toBe('fixture refused to start');
    expect(instance.state).toBe(InstanceState.Failed);
  });

  it('stops when idle, answers its tool list without starting, and starts again on a call', async () => {
    const instance = track(stdioServer({ idleTimeoutMs: 150 }));
    await instance.listTools();
    const firstPid = textOf(await instance.callTool('pid', {}));
    await vi.waitFor(() => expect(instance.state).toBe(InstanceState.Stopped));

    expect((await instance.listTools()).length).toBeGreaterThan(0);
    expect(instance.state).toBe(InstanceState.Stopped);

    expect(textOf(await instance.callTool('pid', {}))).not.toBe(firstPid);
  });

  it('never stops a program with a call in flight', async () => {
    const instance = track(stdioServer({ idleTimeoutMs: 100 }));
    await instance.start();
    expect(textOf(await instance.callTool('sleep', { ms: 400 }))).toBe('slept');
  });

  it('lists its tools again once the server says they changed', async () => {
    const instance = track(stdioServer());
    expect((await instance.listTools()).map((tool) => tool.name)).not.toContain('extra');
    await instance.callTool('grow', {});
    await vi.waitFor(async () => expect((await instance.listTools()).map((tool) => tool.name)).toContain('extra'));
  });

  it('gives its program only the allowlist and its own env, in its install folder', async () => {
    vi.stubEnv('AI_ROUTER_PLANTED_SECRET', 'leaked');
    const server = stdioServer();
    const instance = track(server);
    const env: unknown = JSON.parse(textOf(await instance.callTool('env', {})));
    expect(env).toEqual({ ...childEnv(homeOf(installDir)), ...server.env });
    expect(env).not.toHaveProperty('AI_ROUTER_PLANTED_SECRET');
    expect(textOf(await instance.callTool('cwd', {}))).toBe(installDir);
  });

  it('is refused, with the reason, when stdio servers are refused', async () => {
    const refused: ChildIsolation = { mode: ChildMode.Refused, reason: 'the helper is missing' };
    const instance = track(stdioServer(), undefined, {}, refused);
    const error = await instanceErrorOf(instance.callTool('pid', {}));
    expect(error.code).toBe(InstanceErrorCode.Refused);
    expect(error.message).toContain('the helper is missing');
    expect(instance.state).toBe(InstanceState.Stopped);
  });
});

describe('stopping a stdio program', () => {
  it('signals a shared program that outlives its stdin', async () => {
    const instance = track(stdioServer({}, ['--linger']), undefined, { closeGraceMs: 100 });
    const pid = Number(textOf(await instance.callTool('pid', {})));
    await instance.stop();
    expect(isRunning(pid)).toBe(false);
  });

  it('moves an isolated program into its folder with env -C, and signals it through the helper as its user', async () => {
    const calls: { command: string; args: string[] }[] = [];
    const exec: ChildExec = (command, args, options) => {
      calls.push({ command, args });
      return execChild(command, args, options);
    };
    const instance = new Instance(
      stdioServer({}, ['--linger']),
      { isolation: ISOLATED, exec, helperPath },
      { closeGraceMs: 100 },
    );
    running.push(instance);
    expect(textOf(await instance.callTool('cwd', {}))).toBe(installDir);
    const pid = textOf(await instance.callTool('pid', {}));

    await instance.stop();
    expect(calls).toEqual([
      {
        command: helperPath,
        args: [String(CHILD_DEFAULTS.uidMin), '--', process.execPath, '-e', expect.any(String), pid, 'SIGTERM'],
      },
    ]);
    expect(isRunning(Number(pid))).toBe(false);
  });

  it('runs a workspace instance as its own uid with the server’s groups, in the server’s folder with its own HOME', async () => {
    const calls: { command: string; args: string[] }[] = [];
    const exec: ChildExec = (command, args, options) => {
      calls.push({ command, args });
      return execChild(command, args, options);
    };
    const homeDir = path.join(installDir, 'workspace-home');
    await mkdir(path.join(homeDir, 'tmp'), { recursive: true });
    const { uidMin } = CHILD_DEFAULTS;
    const server = stdioServer(
      { workspaceId: 'workspace-1', runAs: { uid: uidMin + 1, gid: uidMin, groups: [100, 2000] }, homeDir },
      ['--linger'],
    );
    const instance = new Instance(server, { isolation: ISOLATED, exec, helperPath }, { closeGraceMs: 100 });
    running.push(instance);
    expect(textOf(await instance.callTool('cwd', {}))).toBe(installDir);
    const env: unknown = JSON.parse(textOf(await instance.callTool('env', {})));
    expect(env).toMatchObject({ HOME: homeDir, TMPDIR: path.join(homeDir, 'tmp') });
    const pid = textOf(await instance.callTool('pid', {}));

    await instance.stop();
    expect(calls[0]?.args).toEqual([
      String(uidMin + 1),
      '-g',
      String(uidMin),
      '-G',
      '100,2000',
      '--',
      process.execPath,
      '-e',
      expect.any(String),
      pid,
      'SIGTERM',
    ]);
  });

  it('refuses a workspace instance whose folder is not made yet', async () => {
    const instance = track(stdioServer({ workspaceId: 'workspace-1', homeDir: null }));
    const error = await instanceErrorOf(instance.start());
    expect(error.code).toBe(InstanceErrorCode.Refused);
  });

  it('refuses an isolated command that env would read as a variable', async () => {
    const server = stdioServer({ transport: { type: TRANSPORT_STDIO, command: 'A=b', args: [] } });
    const instance = track(server, undefined, {}, ISOLATED);
    const error = await instanceErrorOf(instance.start());
    expect(error.code).toBe(InstanceErrorCode.Refused);
  });
});

describe('a streamable-HTTP instance', () => {
  it('counts its calls in flight', async () => {
    const instance = track(httpServer());
    const call = instance.callTool('header', {});
    expect(instance.inFlightCount).toBe(1);
    await call;
    expect(instance.inFlightCount).toBe(0);
  });

  it('connects, lists, and calls with its headers', async () => {
    const events: ToolCallEvent[] = [];
    const instance = track(httpServer({ [FIXTURE_HEADER]: 'from-the-router' }), (event) => events.push(event));
    expect((await instance.listTools()).map((tool) => tool.name)).toEqual(['header']);
    expect(textOf(await instance.callTool('header', {}))).toBe('from-the-router');
    expect(events[0]).toMatchObject({ serverId: 'server-2', workspaceId: 'workspace-1', ok: true });
  });

  it('opens a new session when the server forgot the old one', async () => {
    const instance = track(httpServer());
    await instance.callTool('header', {});
    const before = http.sessionsOpened();
    http.dropSessions();
    expect(textOf(await instance.callTool('header', {}))).toBe('');
    expect(http.sessionsOpened()).toBe(before + 1);
  });

  it('is never stopped for being idle', async () => {
    const instance = track({ ...httpServer(), idleTimeoutMs: 50 });
    await instance.start();
    await delay(150);
    expect(instance.state).toBe(InstanceState.Ready);
  });
});

describe('an SSE instance', () => {
  it('connects, lists, and calls with its headers, on its event stream and on every message', async () => {
    const events: ToolCallEvent[] = [];
    const instance = track(sseServer({ [FIXTURE_HEADER]: 'over-sse' }), (event) => events.push(event));
    expect((await instance.listTools()).map((tool) => tool.name)).toEqual(['header']);
    expect(textOf(await instance.callTool('header', {}))).toBe('over-sse');
    expect(sse.streamHeader()).toBe('over-sse');
    expect(events[0]).toMatchObject({ serverId: 'server-3', ok: true });
  });

  it('opens a new session when the server forgot the old one, and sends the call again', async () => {
    const instance = track(sseServer());
    await instance.callTool('header', {});
    const before = sse.sessionsOpened();
    sse.dropSessions();
    expect(textOf(await instance.callTool('header', {}))).toBe('');
    expect(sse.sessionsOpened()).toBe(before + 1);
  });

  it('is never stopped for being idle', async () => {
    const instance = track({ ...sseServer(), idleTimeoutMs: 50 });
    await instance.start();
    await delay(150);
    expect(instance.state).toBe(InstanceState.Ready);
  });

  it('fails to start, as a streamable-HTTP one does, when nothing answers at its address', async () => {
    const instance = track({
      ...sseServer(),
      transport: { type: TRANSPORT_SSE, url: `${http.url}/nothing`, headers: {} },
    });
    const error = await instanceErrorOf(instance.start());
    expect(error.code).toBe(InstanceErrorCode.StartFailed);
    expect(instance.state).toBe(InstanceState.Failed);
  });
});
