import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHILD_DEFAULTS, INSTALL_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { type ChildIsolation, ChildMode, type ChildUser, serverChildUser } from '../../server/tools/child-users.ts';
import {
  ChildCommandError,
  type ChildExec,
  childCommand,
  childEnv,
  createInstallFolder,
  FolderKind,
  homeOf,
  installFolderPath,
  removeInstallFolder,
  runAsServer,
} from '../../server/tools/install-folder.ts';

const run = promisify(execFile);

const HELPER = '/usr/local/bin/run-as-child';
const UID = CHILD_DEFAULTS.uidMin;
/** The server's own user. */
const SERVER = serverChildUser(UID);
/** A workspace instance of that server: its own uid, the server's group, and a mounted folder's group. */
const INSTANCE: ChildUser = { uid: UID + 1, gid: UID, groups: [100, 2000] };
const ISOLATED: ChildIsolation = { mode: ChildMode.Isolated, reason: '' };
const SHARED: ChildIsolation = { mode: ChildMode.Shared, reason: 'no helper here' };
const REFUSED: ChildIsolation = { mode: ChildMode.Refused, reason: 'the helper cannot switch users' };
/** The mode bits a test compares. */
const MODE_BITS = 0o7777;
/** What the helper reads before the command. */
const END_OF_OPTIONS = '--';
/** After the helper's options: `timeout`, `--kill-after=…` and the duration, before the bounded command. */
const TIMEOUT_ARGS = 3;

/** One command as the fake helper was asked to run it. */
interface Call {
  command: string;
  args: string[];
  env: Record<string, string>;
}

let root: string;
let calls: Call[];

/**
 * Reads the command a call to the helper bounded with `timeout`.
 *
 * @param call - The call.
 * @returns The command and its arguments.
 */
function innerCommand(call: Call | undefined): string[] {
  const args = call?.args ?? [];
  return args.slice(args.indexOf(END_OF_OPTIONS) + 1 + TIMEOUT_ARGS);
}

/**
 * A stand-in for `run-as-child`: records the call, drops the helper's options and the `timeout` prefix, and runs
 * the rest as the test's own user. It can't switch users, so a folder it makes is never owned by the child.
 *
 * @param [replace] - Runs instead of the real command when it answers true, for a command it fakes.
 * @returns The exec.
 */
function fakeHelper(replace: (command: string, args: string[]) => Promise<boolean> = async () => false): ChildExec {
  return async (command, args, options) => {
    const call = { command, args, env: options.env };
    calls.push(call);
    const [inner = '', ...innerArgs] = innerCommand(call);
    const isFaked = await replace(inner, innerArgs);
    if (isFaked) {
      return { stdout: '', stderr: '' };
    }
    return run(inner, innerArgs, { env: options.env });
  };
}

beforeEach(async () => {
  root = path.join(await mkdtemp(path.join(tmpdir(), 'ai-router-folders-')), 'servers');
  calls = [];
});

afterEach(async () => {
  await rm(path.dirname(root), { recursive: true, force: true });
});

describe('childEnv', () => {
  it('is a fixed allowlist with every writable place inside HOME', () => {
    const env = childEnv('/data/servers/10000-abc/home');
    expect(env).toEqual({
      PATH: INSTALL_DEFAULTS.childPath,
      HOME: '/data/servers/10000-abc/home',
      TMPDIR: '/data/servers/10000-abc/home/tmp',
      LANG: 'C.UTF-8',
      npm_config_cache: '/data/servers/10000-abc/home/.npm',
      npm_config_update_notifier: 'false',
      UV_CACHE_DIR: '/data/servers/10000-abc/home/.cache/uv',
      UV_PYTHON_INSTALL_DIR: '/data/servers/10000-abc/home/.local/share/uv/python',
      UV_TOOL_DIR: '/data/servers/10000-abc/home/.local/share/uv/tools',
    });
  });

  it('carries nothing from the router environment', () => {
    process.env.AI_ROUTER_TEST_SECRET = 'leak';
    try {
      expect(Object.values(childEnv('/x'))).not.toContain('leak');
    } finally {
      delete process.env.AI_ROUTER_TEST_SECRET;
    }
  });
});

describe('childCommand', () => {
  it('starts a server’s own command through the helper with no group options', () => {
    expect(childCommand(ISOLATED, SERVER, 'node', ['a.js'], HELPER)).toEqual({
      command: HELPER,
      args: [String(UID), END_OF_OPTIONS, 'node', 'a.js'],
    });
  });

  it('passes another primary group and the extra groups, then ends the options', () => {
    expect(childCommand(ISOLATED, INSTANCE, '-starts-with-a-dash', [], HELPER)).toEqual({
      command: HELPER,
      args: [String(UID + 1), '-g', String(UID), '-G', '100,2000', END_OF_OPTIONS, '-starts-with-a-dash'],
    });
  });

  it('passes extra groups for a server’s own uid without -g', () => {
    expect(childCommand(ISOLATED, serverChildUser(UID, [100]), 'id', [], HELPER).args).toEqual([
      String(UID),
      '-G',
      '100',
      END_OF_OPTIONS,
      'id',
    ]);
  });

  it('runs the command as it is when shared', () => {
    expect(childCommand(SHARED, INSTANCE, 'node', ['a.js'], HELPER)).toEqual({ command: 'node', args: ['a.js'] });
  });

  it('refuses with the boot check reason', () => {
    expect(() => childCommand(REFUSED, SERVER, 'node', [], HELPER)).toThrow(REFUSED.reason);
  });
});

describe('runAsServer', () => {
  it('bounds an isolated command with timeout, as the child', async () => {
    const exec: ChildExec = async (command, args) => {
      calls.push({ command, args, env: {} });
      return { stdout: 'ok', stderr: '' };
    };
    const user = { isolation: ISOLATED, runAs: INSTANCE, homeDir: '/f/home', exec, helperPath: HELPER };
    expect(await runAsServer(user, 'cat', ['x'], 10_000, { killGraceMs: 500 })).toBe('ok');
    expect(calls[0]).toMatchObject({
      command: HELPER,
      args: [
        String(UID + 1),
        '-g',
        String(UID),
        '-G',
        '100,2000',
        '--',
        'timeout',
        '--kill-after=0.5s',
        '10s',
        'cat',
        'x',
      ],
    });
  });

  it('reports what timeout stopped as timed out', async () => {
    const exec: ChildExec = async () => {
      throw Object.assign(new Error('Command failed'), { code: 124, stderr: '' });
    };
    const user = { isolation: ISOLATED, runAs: SERVER, homeDir: '/f/home', exec, helperPath: HELPER };
    const failure = await runAsServer(user, 'npm', [], 1_000).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChildCommandError);
    expect(failure).toMatchObject({ timedOut: true });
  });

  it('keeps the end of stderr when a command fails', async () => {
    const exec: ChildExec = async () => {
      throw Object.assign(new Error('Command failed'), { code: 1, stderr: 'npm ERR! 404 Not Found\n' });
    };
    const user = { isolation: ISOLATED, runAs: SERVER, homeDir: '/f/home', exec, helperPath: HELPER };
    await expect(runAsServer(user, 'npm', [], 1_000)).rejects.toMatchObject({
      timedOut: false,
      detail: 'npm ERR! 404 Not Found',
    });
  });

  it('stops a shared command that overruns', async () => {
    const user = { isolation: SHARED, runAs: SERVER, homeDir: root };
    await expect(runAsServer(user, 'sleep', ['5'], 50)).rejects.toMatchObject({ timedOut: true });
  });
});

describe('createInstallFolder', () => {
  it('makes a 0750 install folder with a 0700 home and tmp inside, named after the uid, when shared', async () => {
    const folder = await createInstallFolder(SHARED, SERVER, { root });
    expect(folder.name).toMatch(new RegExp(`^${UID}-[0-9a-f]{${INSTALL_DEFAULTS.folderRandomBytes * 2}}$`));
    expect(folder.path).toBe(path.join(root, folder.name));
    expect(folder.homeDir).toBe(homeOf(folder.path));
    expect((await stat(folder.path)).mode & MODE_BITS).toBe(0o750);
    expect((await stat(folder.homeDir)).mode & MODE_BITS).toBe(0o700);
    expect((await stat(path.join(folder.homeDir, 'tmp'))).mode & MODE_BITS).toBe(0o700);
  });

  it('makes a workspace instance’s folder 0700, named after its own uid', async () => {
    const folder = await createInstallFolder(SHARED, INSTANCE, { root, kind: FolderKind.Instance });
    expect(folder.name.startsWith(`${INSTANCE.uid}-`)).toBe(true);
    expect((await stat(folder.path)).mode & MODE_BITS).toBe(0o700);
    expect((await stat(folder.homeDir)).mode & MODE_BITS).toBe(0o700);
  });

  it('never makes the same name twice', async () => {
    const first = await createInstallFolder(SHARED, SERVER, { root });
    const second = await createInstallFolder(SHARED, SERVER, { root });
    expect(first.name).not.toBe(second.name);
  });

  it('has the child make it private, then open it to its group, in a 1733 root, when isolated', async () => {
    await createInstallFolder(ISOLATED, SERVER, { root, exec: fakeHelper(), helperPath: HELPER }).catch(
      () => undefined,
    );
    const [made, opened] = calls;
    expect(made?.command).toBe(HELPER);
    expect(made?.args.slice(0, 3)).toEqual([String(UID), '--', 'timeout']);
    const [, , , folder = ''] = innerCommand(made);
    const home = homeOf(folder);
    expect(innerCommand(made)).toEqual(['mkdir', '-m', '0700', folder, home, path.join(home, 'tmp')]);
    expect(innerCommand(opened)).toEqual(['chmod', '0750', folder]);
    expect(made?.env).toEqual(childEnv(home));
    expect((await stat(root)).mode & MODE_BITS).toBe(0o1733);
  });

  it('makes a workspace instance’s folder as that instance, and leaves it private', async () => {
    const options = { root, exec: fakeHelper(), helperPath: HELPER, kind: FolderKind.Instance };
    await createInstallFolder(ISOLATED, INSTANCE, options).catch(() => undefined);
    expect(calls[0]?.args.slice(0, 6)).toEqual([String(UID + 1), '-g', String(UID), '-G', '100,2000', '--']);
    expect(calls.map((call) => innerCommand(call)[0])).toEqual(['mkdir', 'rm']);
  });

  it('refuses a folder the child does not own, and removes it', async () => {
    const creating = createInstallFolder(ISOLATED, SERVER, { root, exec: fakeHelper(), helperPath: HELPER });
    await expect(creating).rejects.toMatchObject({ extensions: { code: ErrorCode.Conflict } });
    await expect(creating).rejects.toThrow(`not ${UID}`);
    expect(calls.map((call) => innerCommand(call)[0])).toEqual(['mkdir', 'chmod', 'rm']);
  });

  it('removes what it made when opening the folder fails', async () => {
    const exec = fakeHelper(async (command) => {
      if (command === 'chmod') {
        throw new Error('chmod failed');
      }
      return false;
    });
    await expect(createInstallFolder(ISOLATED, SERVER, { root, exec, helperPath: HELPER })).rejects.toThrow(
      'chmod failed',
    );
    expect(calls.map((call) => innerCommand(call)[0])).toEqual(['mkdir', 'chmod', 'rm']);
  });

  it('refuses a symlink in place of the folder', async () => {
    const target = path.join(path.dirname(root), 'elsewhere');
    await mkdir(target);
    const exec = fakeHelper(async (command, args) => {
      if (command === 'mkdir') {
        await symlink(target, args[2] ?? '');
        return true;
      }
      return command === 'chmod';
    });
    await expect(createInstallFolder(ISOLATED, SERVER, { root, exec, helperPath: HELPER })).rejects.toThrow(
      'not a directory',
    );
  });

  it('refuses when child processes are refused', async () => {
    await expect(createInstallFolder(REFUSED, SERVER, { root })).rejects.toMatchObject({
      message: REFUSED.reason,
      extensions: { code: ErrorCode.Conflict },
    });
  });

  it('refuses a uid or group outside the child range', async () => {
    for (const runAs of [serverChildUser(CHILD_DEFAULTS.uidMax + 1), { uid: UID, gid: 0, groups: [] }]) {
      await expect(createInstallFolder(SHARED, runAs, { root })).rejects.toMatchObject({
        extensions: { code: ErrorCode.BadUserInput },
      });
    }
  });
});

describe('installFolderPath', () => {
  it('accepts only a folder name made for that uid', () => {
    expect(installFolderPath(`${UID}-ab12`, UID, '/srv')).toBe(`/srv/${UID}-ab12`);
    expect(() => installFolderPath(`${UID + 1}-ab12`, UID, '/srv')).toThrow();
    expect(() => installFolderPath('../etc', UID, '/srv')).toThrow();
    expect(() => installFolderPath(`${UID}-ab12/../x`, UID, '/srv')).toThrow();
  });
});

describe('removeInstallFolder', () => {
  it('removes a folder and everything in it, read-only parts included, when shared', async () => {
    const folder = await createInstallFolder(SHARED, SERVER, { root });
    const locked = path.join(folder.path, 'go', 'pkg');
    await mkdir(locked, { recursive: true });
    await writeFile(path.join(locked, 'mod'), 'x');
    await chmod(locked, 0o500);
    await removeInstallFolder(SHARED, SERVER, folder.name, { root });
    await expect(lstat(folder.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is fine with a folder that is already gone', async () => {
    await expect(removeInstallFolder(SHARED, SERVER, `${UID}-00`, { root })).resolves.toBeUndefined();
  });

  it('has the child make its files writable, then remove them, when isolated', async () => {
    const folder = path.join(root, `${UID}-ab12`);
    await mkdir(folder, { recursive: true });
    await removeInstallFolder(ISOLATED, SERVER, `${UID}-ab12`, { root, exec: fakeHelper(), helperPath: HELPER });
    expect(calls.map((call) => innerCommand(call))).toEqual([
      ['chmod', '-R', 'u+rwX', folder],
      ['rm', '-rf', folder],
    ]);
    expect(calls.every((call) => call.command === HELPER && call.args[0] === String(UID))).toBe(true);
  });

  it('refuses a name that is not that uid’s folder', async () => {
    await expect(removeInstallFolder(SHARED, SERVER, '..', { root })).rejects.toMatchObject({
      extensions: { code: ErrorCode.BadUserInput },
    });
    await expect(removeInstallFolder(SHARED, INSTANCE, `${UID}-ab12`, { root })).rejects.toMatchObject({
      extensions: { code: ErrorCode.BadUserInput },
    });
  });
});
