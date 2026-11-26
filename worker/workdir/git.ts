import { spawn } from 'node:child_process';

/** How one git command ended. A non-zero exit is an answer, not a throw. */
export interface GitResult {
  /** The process's exit code, or null when a signal ended it. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Where and for how long one git command runs. */
export interface GitRunOptions {
  /** The directory git runs in. */
  cwd: string;
  /** How long it may run before it is killed. */
  timeoutMs: number;
}

/**
 * Runs `git` with an argument array, never a shell string.
 *
 * @remarks
 * Injected into the workdir server, so tests answer with a fake and never touch the network. It throws only when
 * git could not run at all or ran past its timeout.
 */
export type GitRunner = (args: readonly string[], options: GitRunOptions) => Promise<GitResult>;

/** The git program, found on PATH. */
const GIT_COMMAND = 'git';

/**
 * Builds the real runner, which spawns git with no shell and no prompt for credentials.
 *
 * @returns A runner over `child_process.spawn`.
 */
export function createGitRunner(): GitRunner {
  return (args, { cwd, timeoutMs }) =>
    new Promise((resolve, reject) => {
      const child = spawn(GIT_COMMAND, [...args], {
        cwd,
        // A prompt would wait forever for a person who isn't there.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(timeoutMs),
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', (error) => {
        const timedOut = error.name === 'AbortError';
        reject(timedOut ? new Error(`git ${args[0]} took longer than ${timeoutMs} ms and was stopped.`) : error);
      });
      child.once('close', (exitCode) => {
        resolve({
          exitCode,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
    });
}
