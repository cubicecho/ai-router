import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkdirSettings } from '../defaults.ts';
import type { GitResult, GitRunner } from './git.ts';
import { WorkdirRefusal } from './refusal.ts';
import type { RepoRef } from './repo-ref.ts';
import { isInsideRoot } from './root.ts';

/** What `open_repo` answers. */
export interface OpenedRepo {
  /** The checkout's real path. */
  path: string;
  /** true when this call cloned it, false when it was already there. */
  cloned: boolean;
  /** The checked-out branch, or null when HEAD is detached. */
  branch: string | null;
  /** HEAD's commit sha, or null when the repo has no commits yet. */
  head: string | null;
}

/** The folder that makes a directory a git checkout. */
const GIT_DIR = '.git';

/**
 * Returns the checkout of a repo under the root, cloning it first when there is none.
 *
 * @param rootPath - The real root.
 * @param ref - The repo, already checked by `parseRepo`.
 * @param git - Runs git.
 * @param settings - The clone and command timeouts.
 * @returns Where the checkout is and what it has checked out.
 * @throws {@link WorkdirRefusal} If the place is taken by something else, a symlink leads outside the root, or the
 * clone fails.
 */
export async function openRepo(
  rootPath: string,
  ref: RepoRef,
  git: GitRunner,
  settings: WorkdirSettings,
): Promise<OpenedRepo> {
  const ownerPath = await makeFolderInside(rootPath, [ref.host, ref.owner]);
  const checkout = join(ownerPath, ref.name);
  const exists = await lstat(checkout).then(
    () => true,
    () => false,
  );
  if (exists) {
    const real = await realpath(checkout);
    if (isInsideRoot(rootPath, real) === false) {
      throw new WorkdirRefusal(`The checkout of ${ref.cloneUrl} is a symlink that leads outside the work root.`);
    }
    const isCheckout = await lstat(join(real, GIT_DIR)).then(
      () => true,
      () => false,
    );
    if (isCheckout === false) {
      throw new WorkdirRefusal(
        `${real} is already there and is not a git checkout, so ${ref.cloneUrl} can't go there.`,
      );
    }
    return { path: real, cloned: false, ...(await describeCheckout(real, git, settings)) };
  }
  const clone = await git(['clone', '--', ref.cloneUrl, checkout], {
    cwd: ownerPath,
    timeoutMs: settings.cloneTimeoutMs,
  });
  if (clone.exitCode !== 0) {
    throw new WorkdirRefusal(`git clone of ${ref.cloneUrl} failed: ${clone.stderr.trim() || `exit ${clone.exitCode}`}`);
  }
  return { path: checkout, cloned: true, ...(await describeCheckout(checkout, git, settings)) };
}

/**
 * Makes each folder of a path under the root, checking after each that no symlink has led outside it.
 *
 * @param rootPath - The real root.
 * @param segments - Folder names, each already checked.
 * @returns The real path of the last folder.
 * @throws {@link WorkdirRefusal} If one of the folders is a symlink that leads outside the root.
 */
async function makeFolderInside(rootPath: string, segments: readonly string[]): Promise<string> {
  let current = rootPath;
  for (const segment of segments) {
    const next = join(current, segment);
    // Not recursive, so nothing is ever made through a symlink before it is checked.
    await mkdir(next).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    });
    current = await realpath(next);
    if (isInsideRoot(rootPath, current) === false) {
      throw new WorkdirRefusal(`${next} is a symlink that leads outside the work root.`);
    }
  }
  return current;
}

/**
 * Reads a checkout's branch and HEAD.
 *
 * @param checkout - The checkout's real path.
 * @param git - Runs git.
 * @param settings - The command timeout.
 * @returns The branch and sha, each null when git has none to give.
 */
async function describeCheckout(
  checkout: string,
  git: GitRunner,
  settings: WorkdirSettings,
): Promise<Pick<OpenedRepo, 'branch' | 'head'>> {
  const options = { cwd: checkout, timeoutMs: settings.gitCommandTimeoutMs };
  const [branch, head] = await Promise.all([
    git(['symbolic-ref', '--short', '-q', 'HEAD'], options),
    git(['rev-parse', '--verify', '-q', 'HEAD'], options),
  ]);
  return { branch: answerOf(branch), head: answerOf(head) };
}

/**
 * Reads a git command's one-line answer.
 *
 * @param result - How the command ended.
 * @returns Its trimmed output, or null when it failed or said nothing.
 */
function answerOf(result: GitResult): string | null {
  const answer = result.stdout.trim();
  const answered = result.exitCode === 0 && answer !== '';
  return answered ? answer : null;
}
