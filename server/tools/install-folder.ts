import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { runAsChildPath, serversDir } from '../core/config.ts';
import { CHILD_DEFAULTS, INSTALL_DEFAULTS, type InstallSettings } from '../core/defaults.ts';
import { badInput, conflict, errorMessage } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import { type ChildIsolation, ChildMode } from './child-users.ts';

/**
 * A server's own folder: its HOME, where its packages, caches and temp files go.
 *
 * `serversDir()` belongs to the router with mode 1733: every child may create an entry in it, but
 * none may list it or delete an entry it doesn't own. A server's folder is `<uid>-<random hex>`,
 * made by the server's own user with mode 0700, so no other child can guess its name, squat it,
 * read it or remove it. The router can't read inside it either, so it reads through the child.
 */

/** `serversDir()`: owner rwx, everyone else write and search only, sticky. */
const SERVERS_DIR_MODE = 0o1733;
/** The permission bits of a mode, setuid, setgid and sticky included. */
const MODE_BITS = 0o7777;
/** A server's folder: only its own user may enter it. */
const FOLDER_MODE = 0o700;
/** `FOLDER_MODE` as `mkdir -m` reads it. */
const FOLDER_MODE_ARG = '0700';
/** A folder name: the uid, a dash, then lowercase hex. */
const FOLDER_NAME = /^\d+-[0-9a-f]+$/;
/** The locale every child gets: present on every Linux, and UTF-8. */
const CHILD_LOCALE = 'C.UTF-8';
/** What GNU `timeout` exits with when its signal stopped the command. */
const TIMEOUT_EXIT_CODE = 124;
/** What it exits with when the command needed SIGKILL: 128 plus the signal's number. */
const TIMEOUT_KILLED_EXIT_CODE = 137;
/** Both, as `execFile` reports them in `error.code`. */
const TIMED_OUT_EXIT_CODES: readonly unknown[] = [TIMEOUT_EXIT_CODE, TIMEOUT_KILLED_EXIT_CODE];
/** The radix a file mode is written in. */
const OCTAL = 8;

/** How a child command is run: `execFile`, never a shell. */
export interface ChildExecOptions {
  /** When the router stops waiting, in ms. */
  timeout: number;
  /** The whole environment the command gets. */
  env: Record<string, string>;
}

/** Runs a program with an argument array and answers its output. Tests pass a fake. */
export type ChildExec = (
  command: string,
  args: string[],
  options: ChildExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);

/**
 * Runs a program through `child_process.execFile`, with no shell.
 *
 * @param command - The program.
 * @param args - Its arguments.
 * @param options - The timeout and the environment.
 * @returns What it wrote to stdout and stderr. Rejects with execFile's error when it fails.
 */
export const execChild: ChildExec = (command, args, options) => execFileAsync(command, args, options);

/** One server's user, and where it lives. */
export interface ServerUser {
  isolation: ChildIsolation;
  /** The uid the server runs as. */
  childUid: number;
  /** The server's folder, as an absolute path. */
  installDir: string;
  /** Runs the command; `execChild` when absent. */
  exec?: ChildExec;
  /** The helper's path; `runAsChildPath()` when absent. */
  helperPath?: string;
}

/** What a server's folder is called and where it is. */
export interface InstallFolder {
  /** The folder's name inside `serversDir()`: what `servers.install_dir` keeps. */
  name: string;
  /** The absolute path: the server's HOME. */
  path: string;
}

/** What creating or removing a folder may be given instead of the real thing, for tests. */
export interface FolderOptions {
  /** Where folders go; `serversDir()` when absent. */
  root?: string;
  exec?: ChildExec;
  helperPath?: string;
  /** Settings that differ from `INSTALL_DEFAULTS`. */
  overrides?: Partial<InstallSettings>;
}

/** A command run as a server's user that failed or overran. */
export class ChildCommandError extends Error {
  /** Whether it was stopped for running too long. */
  readonly timedOut: boolean;
  /** The end of its stderr, or the reason it couldn't start. */
  readonly detail: string;

  /**
   * Builds the error.
   *
   * @param message - What failed.
   * @param timedOut - Whether it overran.
   * @param detail - The end of its stderr.
   */
  constructor(message: string, timedOut: boolean, detail: string) {
    super(message);
    this.name = 'ChildCommandError';
    this.timedOut = timedOut;
    this.detail = detail;
  }
}

/**
 * The environment every child process gets, and nothing from the router's own.
 *
 * @param installDir - The server's folder, as an absolute path.
 * @returns A fixed PATH and locale, with HOME, TMPDIR and npm's and uv's caches inside the folder.
 */
export function childEnv(installDir: string): Record<string, string> {
  return {
    PATH: INSTALL_DEFAULTS.childPath,
    HOME: installDir,
    TMPDIR: path.join(installDir, 'tmp'),
    LANG: CHILD_LOCALE,
    npm_config_cache: path.join(installDir, '.npm'),
    npm_config_update_notifier: 'false',
    UV_CACHE_DIR: path.join(installDir, '.cache', 'uv'),
    UV_PYTHON_INSTALL_DIR: path.join(installDir, '.local', 'share', 'uv', 'python'),
    UV_TOOL_DIR: path.join(installDir, '.local', 'share', 'uv', 'tools'),
  };
}

/**
 * Turns a command into the one that runs it as a server's user.
 *
 * @param isolation - What the boot check found.
 * @param uid - The server's uid. Unused when shared.
 * @param command - The program.
 * @param args - Its arguments.
 * @param [helperPath] - Where `run-as-child` is.
 * @returns `run-as-child <uid> <command> <args…>` when isolated, the command as it is when shared.
 * @throws CONFLICT with the boot check's reason when child processes are refused.
 */
export function childCommand(
  isolation: ChildIsolation,
  uid: number,
  command: string,
  args: string[],
  helperPath: string = runAsChildPath(),
): { command: string; args: string[] } {
  if (isolation.mode === ChildMode.Isolated) {
    return { command: helperPath, args: [String(uid), command, ...args] };
  }
  if (isolation.mode === ChildMode.Shared) {
    return { command, args: [...args] };
  }
  throw conflict(isolation.reason);
}

/**
 * Formats milliseconds as a GNU `timeout` duration.
 *
 * @param ms - The duration.
 * @returns Seconds with an `s`, fractions kept.
 */
function timeoutDuration(ms: number): string {
  return `${ms / MS_PER_SECOND}s`;
}

/**
 * Whether a failed `execFile` was stopped for running too long.
 *
 * @param error - What it rejected with.
 * @returns true when execFile killed it, tried to and wasn't allowed, or `timeout` stopped it.
 */
function isTimeout(error: unknown): boolean {
  if (isRecord(error) === false) {
    return false;
  }
  // The router may not signal another user's process, and execFile reports that as a failed `kill`.
  return error.killed === true || error.syscall === 'kill' || TIMED_OUT_EXIT_CODES.includes(error.code);
}

/**
 * Runs one short command as a server's user, with the child env of its folder.
 *
 * @param user - The server's user and folder.
 * @param command - The program.
 * @param args - Its arguments.
 * @param timeoutMs - How long it may run.
 * @param [overrides] - Settings that differ from `INSTALL_DEFAULTS`.
 * @returns What it wrote to stdout.
 * @throws {@link ChildCommandError} When it fails or overruns. CONFLICT when child processes are refused.
 *
 * @remarks
 * The router may not signal a process that runs as another user, so an isolated command runs under
 * `timeout`, as that user, which stops it and everything it started. The router's own timeout is the
 * backstop.
 */
export async function runAsServer(
  user: ServerUser,
  command: string,
  args: string[],
  timeoutMs: number,
  overrides: Partial<InstallSettings> = {},
): Promise<string> {
  const { killGraceMs, stderrTailChars } = { ...INSTALL_DEFAULTS, ...overrides };
  const { isolation, childUid, installDir, exec = execChild, helperPath = runAsChildPath() } = user;
  const isIsolated = isolation.mode === ChildMode.Isolated;
  const bounded = isIsolated
    ? childCommand(
        isolation,
        childUid,
        'timeout',
        [`--kill-after=${timeoutDuration(killGraceMs)}`, timeoutDuration(timeoutMs), command, ...args],
        helperPath,
      )
    : childCommand(isolation, childUid, command, args, helperPath);
  const waitMs = isIsolated ? timeoutMs + killGraceMs + killGraceMs : timeoutMs;
  try {
    const { stdout } = await exec(bounded.command, bounded.args, { timeout: waitMs, env: childEnv(installDir) });
    return stdout;
  } catch (error) {
    const stderr = isRecord(error) && typeof error.stderr === 'string' ? error.stderr.trim() : '';
    const detail = stderr === '' ? errorMessage(error) : stderr.slice(-stderrTailChars);
    throw new ChildCommandError(`${command} failed as uid ${childUid}: ${detail}`, isTimeout(error), detail);
  }
}

/**
 * Refuses a uid the helper would refuse.
 *
 * @param childUid - The uid.
 * @throws BAD_USER_INPUT outside the child range.
 */
function assertChildUid(childUid: number): void {
  const { uidMin, uidMax } = CHILD_DEFAULTS;
  const isInRange = Number.isInteger(childUid) && childUid >= uidMin && childUid <= uidMax;
  if (isInRange === false) {
    throw badInput(`${childUid} is not a child uid (${uidMin}–${uidMax}).`);
  }
}

/**
 * Names the path of a server's folder, after checking the name is one this module made for that uid.
 *
 * @param name - The folder's name, as `servers.install_dir` keeps it.
 * @param childUid - The server's uid, which the name starts with.
 * @param [root] - Where folders go.
 * @returns The absolute path.
 * @throws BAD_USER_INPUT for any other name, so a stored value can never point outside `root`.
 */
export function installFolderPath(name: string, childUid: number, root: string = serversDir()): string {
  const isOwnName = FOLDER_NAME.test(name) && name.startsWith(`${childUid}-`);
  if (isOwnName === false) {
    throw badInput(`"${name}" is not an install folder of uid ${childUid}.`);
  }
  return path.join(root, name);
}

/**
 * Makes sure the folder that holds every server's folder exists, and, when isolated, has mode 1733.
 *
 * @param root - The folder.
 * @param isIsolated - Whether children run as their own users.
 * @throws CONFLICT when it is not a directory, or its mode can't be set because the router doesn't own it.
 */
async function ensureServersDir(root: string, isIsolated: boolean): Promise<void> {
  await mkdir(root, { recursive: true });
  const stats = await lstat(root);
  if (stats.isDirectory() === false) {
    throw conflict(`${root} is not a directory, so no server can be given a folder in it.`);
  }
  const needsMode = isIsolated && (stats.mode & MODE_BITS) !== SERVERS_DIR_MODE;
  if (needsMode) {
    try {
      await chmod(root, SERVERS_DIR_MODE);
    } catch (error) {
      throw conflict(`${root} must have mode 1733 for servers to have folders of their own: ${errorMessage(error)}`);
    }
  }
}

/**
 * Checks that a just-made folder is what was asked for.
 *
 * @param folder - The folder.
 * @param owner - The uid that must own it, or null to skip that check.
 * @returns Why it isn't, or an empty string when it is.
 */
async function folderProblem(folder: string, owner: number | null): Promise<string> {
  const stats = await lstat(folder);
  if (stats.isSymbolicLink() || stats.isDirectory() === false) {
    return 'it is not a directory';
  }
  if (owner !== null && stats.uid !== owner) {
    return `it is owned by uid ${stats.uid}, not ${owner}`;
  }
  if ((stats.mode & MODE_BITS) !== FOLDER_MODE) {
    return `its mode is ${(stats.mode & MODE_BITS).toString(OCTAL)}, not ${FOLDER_MODE_ARG}`;
  }
  return '';
}

/**
 * Creates a server's folder, as the server's own user, with a name no other child can guess.
 *
 * @param isolation - What the boot check found.
 * @param childUid - The server's uid.
 * @param [options] - The root, the command runner and settings, for tests.
 * @returns The folder's name, for `servers.install_dir`, and its path.
 * @throws CONFLICT when child processes are refused, or the folder can't be made or isn't what was asked for.
 *
 * @remarks
 * Isolated: `run-as-child <uid> mkdir -m 0700 <folder> <folder>/tmp`, then the router refuses anything
 * but a real directory owned by that uid. Shared: the router makes it itself. `mkdir` fails on a name
 * that already exists, so nothing made in advance is ever taken over.
 */
export async function createInstallFolder(
  isolation: ChildIsolation,
  childUid: number,
  { root = serversDir(), exec, helperPath, overrides = {} }: FolderOptions = {},
): Promise<InstallFolder> {
  assertChildUid(childUid);
  if (isolation.mode === ChildMode.Refused) {
    throw conflict(isolation.reason);
  }
  const { folderRandomBytes, folderTimeoutMs } = { ...INSTALL_DEFAULTS, ...overrides };
  const isIsolated = isolation.mode === ChildMode.Isolated;
  await ensureServersDir(root, isIsolated);
  const name = `${childUid}-${randomBytes(folderRandomBytes).toString('hex')}`;
  const folder = path.join(root, name);
  const user: ServerUser = { isolation, childUid, installDir: folder, exec, helperPath };
  try {
    await runAsServer(
      user,
      'mkdir',
      ['-m', FOLDER_MODE_ARG, folder, path.join(folder, 'tmp')],
      folderTimeoutMs,
      overrides,
    );
  } catch (error) {
    throw conflict(`Could not create a folder for uid ${childUid}: ${errorMessage(error)}`);
  }
  const problem = await folderProblem(folder, isIsolated ? childUid : null);
  if (problem !== '') {
    await removeQuietly(user, folderTimeoutMs, overrides);
    throw conflict(`Refused the folder made for uid ${childUid}, because ${problem}.`);
  }
  return { name, path: folder };
}

/**
 * Removes whatever is at a folder's path, as the server's user, and ignores a failure.
 *
 * @param user - The server's user and folder.
 * @param timeoutMs - How long `rm` may take.
 * @param overrides - Settings that differ from `INSTALL_DEFAULTS`.
 */
async function removeQuietly(user: ServerUser, timeoutMs: number, overrides: Partial<InstallSettings>): Promise<void> {
  try {
    await runAsServer(user, 'rm', ['-rf', user.installDir], timeoutMs, overrides);
  } catch {
    // Whatever it is, the server's user couldn't remove it, and it is refused either way.
  }
}

/**
 * Removes a server's folder and everything in it, as the server's own user.
 *
 * @param isolation - What the boot check found.
 * @param childUid - The server's uid.
 * @param name - The folder's name, as `servers.install_dir` keeps it.
 * @param [options] - The root, the command runner and settings, for tests.
 * @throws BAD_USER_INPUT for a name that isn't that uid's folder. CONFLICT when child processes are
 * refused, or the folder can't be removed.
 *
 * @remarks
 * A folder that is already gone is not an error. A server may leave read-only folders, such as Go's
 * module cache, that `rm` alone can't empty, so its own files are made writable first.
 */
export async function removeInstallFolder(
  isolation: ChildIsolation,
  childUid: number,
  name: string,
  { root = serversDir(), exec, helperPath, overrides = {} }: FolderOptions = {},
): Promise<void> {
  const folder = installFolderPath(name, childUid, root);
  if (isolation.mode === ChildMode.Refused) {
    throw conflict(isolation.reason);
  }
  const { folderTimeoutMs } = { ...INSTALL_DEFAULTS, ...overrides };
  const user: ServerUser = { isolation, childUid, installDir: folder, exec, helperPath };
  let isDirectory: boolean;
  try {
    const stats = await lstat(folder);
    isDirectory = stats.isDirectory();
  } catch (error) {
    const isGone = isRecord(error) && error.code === 'ENOENT';
    if (isGone) {
      return;
    }
    throw error;
  }
  if (isDirectory) {
    try {
      await runAsServer(user, 'chmod', ['-R', 'u+rwX', folder], folderTimeoutMs, overrides);
    } catch {
      // rm says what is wrong, if anything is.
    }
  }
  try {
    await runAsServer(user, 'rm', ['-rf', folder], folderTimeoutMs, overrides);
  } catch (error) {
    throw conflict(`Could not remove the folder of uid ${childUid}: ${errorMessage(error)}`);
  }
}
