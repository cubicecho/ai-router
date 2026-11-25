import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_ENV_ALLOWLIST, type LocalServers, startLocalServers } from '../../worker/servers.ts';

/** The stdio fixture the tools tests use: its `env` tool reports what it was started with. */
const FIXTURE = fileURLToPath(new URL('../tools/fixtures/stdio-server.ts', import.meta.url));
/** A call's signal that never fires before the test's own timeout. */
const LONG = 10_000;

let root: string;
let servers: LocalServers | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'program-servers-'));
});

afterEach(async () => {
  await servers?.close();
  servers = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('the local servers', () => {
  it('give a command server only the allowlist and its own env', async () => {
    const baseEnv = {
      PATH: process.env.PATH,
      HOME: '/home/worker',
      LANG: 'C.UTF-8',
      LOGNAME: 'worker',
      SHELL: '/bin/sh',
      AI_ROUTER_WORKER_KEY: 'aiw_secret',
      SOME_TOKEN: 'leak',
    };
    servers = await startLocalServers({
      root,
      baseEnv,
      onChange: () => undefined,
      servers: { fixture: { command: process.execPath, args: [FIXTURE], env: { FIXTURE_GREETING: 'hello' } } },
    });
    const env: Record<string, string> = JSON.parse(
      await servers.callTool('fixture', 'env', {}, AbortSignal.timeout(LONG)),
    );
    const allowed = new Set([...LOCAL_ENV_ALLOWLIST, 'FIXTURE_GREETING']);
    expect(Object.keys(env).filter((name) => allowed.has(name) === false)).toEqual([]);
    expect(env).toMatchObject({ HOME: '/home/worker', LANG: 'C.UTF-8', FIXTURE_GREETING: 'hello' });
  });

  it('leave out a server that fails to start, and one whose name breaks the rule', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let logged: string[] = [];
    try {
      servers = await startLocalServers({
        root,
        onChange: () => undefined,
        servers: {
          broken: { command: process.execPath, args: [FIXTURE, '--die-at-start'] },
          'Bad Name': { command: process.execPath, args: [FIXTURE] },
          workdir: { command: process.execPath, args: [FIXTURE] },
          fixture: { command: process.execPath, args: [FIXTURE] },
        },
      });
      logged = errors.mock.calls.map(([line]) => String(line));
    } finally {
      errors.mockRestore();
    }
    expect(servers.listing().map(({ name }) => name)).toEqual(['workdir', 'fixture']);
    expect(logged.some((line) => line.includes('"broken"'))).toBe(true);
    expect(logged.some((line) => line.includes('"Bad Name"'))).toBe(true);
    expect(logged.some((line) => line.includes('"workdir"'))).toBe(true);
  });

  it("answer a tool's text, and throw its failure", async () => {
    servers = await startLocalServers({
      root,
      onChange: () => undefined,
      servers: { fixture: { command: process.execPath, args: [FIXTURE] } },
    });
    await expect(servers.callTool('fixture', 'echo', { text: 'hi' }, AbortSignal.timeout(LONG))).resolves.toBe('hi');
    await expect(servers.callTool('fixture', 'fail', {}, AbortSignal.timeout(LONG))).rejects.toThrow('it went wrong');
    await expect(servers.callTool('nowhere', 'echo', {}, AbortSignal.timeout(LONG))).rejects.toThrow(
      'no local server named "nowhere"',
    );
  });
});
