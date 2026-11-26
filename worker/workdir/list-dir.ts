import type { Dirent } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkdirSettings } from '../defaults.ts';
import { WorkdirRefusal } from './refusal.ts';
import { resolveInsideRoot } from './root.ts';

/** What kind of thing an entry is. A symlink is never followed. */
export const EntryType = { File: 'file', Dir: 'dir', Symlink: 'symlink', Other: 'other' } as const;
export type EntryType = (typeof EntryType)[keyof typeof EntryType];

/** One entry in a `list_dir` answer. */
export interface DirEntry {
  /** Relative to the listed directory, with `/` between folders. */
  path: string;
  type: EntryType;
  /** Size in bytes, for a file. null for anything else. */
  size: number | null;
}

/** What `list_dir` answers. */
export interface DirListing {
  /** The listed directory's real path. */
  path: string;
  /** How many levels were listed, after the cap. */
  depth: number;
  /** true when the asked depth was over the cap, so `depth` is the cap. */
  depthCapped: boolean;
  /** Folders first in each directory, then by name, depth first. */
  entries: DirEntry[];
  /** true when there were more entries than `maxEntries`, so some are left out. */
  truncated: boolean;
}

/** The folder whose contents are named but never listed. */
const GIT_DIR = '.git';

/**
 * Lists a directory under the root, its subfolders to a depth.
 *
 * @param rootPath - The real root.
 * @param path - Relative to the root, or absolute inside it.
 * @param askedDepth - Levels to list; 1 is the directory's own entries.
 * @param settings - The entry and depth caps.
 * @returns The entries and whether a cap cut them short.
 * @throws {@link WorkdirRefusal} If the path is not a directory, or leads outside the root.
 */
export async function listDir(
  rootPath: string,
  path: string,
  askedDepth: number,
  settings: WorkdirSettings,
): Promise<DirListing> {
  const directory = await resolveInsideRoot(rootPath, path);
  const isDirectory = (await stat(directory)).isDirectory();
  if (isDirectory === false) {
    throw new WorkdirRefusal(`${JSON.stringify(path)} is a file, not a directory.`);
  }
  const depth = Math.min(askedDepth, settings.maxDepth);
  const entries: DirEntry[] = [];
  let truncated = false;

  // Depth first, so each folder's entries sit right under it. Symlinks are listed and never followed.
  const walk = async (folder: string, prefix: string, levelsLeft: number): Promise<void> => {
    const children = sortEntries(await readdir(folder, { withFileTypes: true }));
    for (const child of children) {
      if (entries.length >= settings.maxEntries) {
        truncated = true;
        return;
      }
      const childPath = join(folder, child.name);
      const type = entryTypeOf(child);
      const size = type === EntryType.File ? (await lstat(childPath)).size : null;
      entries.push({ path: `${prefix}${child.name}`, type, size });
      const descends = type === EntryType.Dir && levelsLeft > 1 && child.name !== GIT_DIR;
      if (descends) {
        await walk(childPath, `${prefix}${child.name}/`, levelsLeft - 1);
      }
    }
  };
  await walk(directory, '', depth);
  return { path: directory, depth, depthCapped: askedDepth > settings.maxDepth, entries, truncated };
}

/**
 * Orders a folder's entries: folders first, then by name.
 *
 * @param children - What `readdir` gave.
 * @returns A sorted copy.
 */
function sortEntries(children: readonly Dirent[]): Dirent[] {
  return [...children].sort((a, b) => {
    const byKind = Number(b.isDirectory()) - Number(a.isDirectory());
    return byKind === 0 ? a.name.localeCompare(b.name) : byKind;
  });
}

/**
 * Names what kind of thing an entry is, without following a symlink.
 *
 * @param child - A `readdir` entry.
 * @returns Its type.
 */
function entryTypeOf(child: Dirent): EntryType {
  if (child.isSymbolicLink()) {
    return EntryType.Symlink;
  }
  if (child.isDirectory()) {
    return EntryType.Dir;
  }
  if (child.isFile()) {
    return EntryType.File;
  }
  return EntryType.Other;
}
