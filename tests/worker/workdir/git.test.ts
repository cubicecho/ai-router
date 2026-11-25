import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRunner } from '../../../worker/workdir/git.ts';

/** Whether git is on PATH here; the Docker test stage has it. */
const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

/** Long enough for git to start on a busy machine. */
const TIMEOUT_MS = 30_000;

describe('createGitRunner', () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'ai-router-git-'));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it.skipIf(gitAvailable === false)('answers a failing command with its exit code, not a throw', async () => {
    const result = await createGitRunner()(['rev-parse', '--verify', '-q', 'HEAD'], {
      cwd: folder,
      timeoutMs: TIMEOUT_MS,
    });

    expect(result.exitCode).not.toBe(0);
  });

  it.skipIf(gitAvailable === false)('passes each argument as it is, with no shell', async () => {
    const result = await createGitRunner()(['--version', '; echo injected'], { cwd: folder, timeoutMs: TIMEOUT_MS });

    expect(result.stdout).not.toContain('injected');
  });
});
