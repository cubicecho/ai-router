import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { WorkdirRefusal } from './refusal.ts';

/** The path `relative` gives for the folder above. */
const PARENT = '..';

/**
 * Makes the root if it is missing, and resolves its real path.
 *
 * @param root - The root as configured.
 * @returns The root with every symlink resolved.
 */
export async function realRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  return realpath(root);
}

/**
 * Tells whether a real path is the root or inside it.
 *
 * @param rootPath - The real root, from {@link realRoot}.
 * @param path - A real path.
 * @returns true when `path` is `rootPath` or below it.
 */
export function isInsideRoot(rootPath: string, path: string): boolean {
  const fromRoot = relative(rootPath, path);
  const leavesRoot = fromRoot === PARENT || fromRoot.startsWith(`${PARENT}${sep}`) || isAbsolute(fromRoot);
  return leavesRoot === false;
}

/**
 * Resolves a path a caller sent to the real path it names, inside the root.
 *
 * @param rootPath - The real root, from {@link realRoot}.
 * @param path - Relative to the root, or absolute.
 * @returns The real path, every symlink resolved.
 * @throws {@link WorkdirRefusal} If nothing is there, or the path or a symlink on it leads outside the root.
 */
export async function resolveInsideRoot(rootPath: string, path: string): Promise<string> {
  const outside = new WorkdirRefusal(`${JSON.stringify(path)} is outside the work root, ${rootPath}.`);
  const asked = resolve(rootPath, path);
  // Checked before and after realpath, so a path outside is refused whether or not anything is there.
  if (isInsideRoot(rootPath, asked) === false) {
    throw outside;
  }
  const real = await realpath(asked).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      throw new WorkdirRefusal(`Nothing is at ${JSON.stringify(path)} under the work root.`);
    }
    throw error;
  });
  if (isInsideRoot(rootPath, real) === false) {
    throw outside;
  }
  return real;
}
