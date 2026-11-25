import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { errorMessage } from '../../server/core/errors.ts';
import { WORKDIR_DEFAULTS, type WorkdirSettings } from '../defaults.ts';
import { createGitRunner, type GitRunner } from './git.ts';
import { listDir } from './list-dir.ts';
import { type OpenedRepo, openRepo } from './open-repo.ts';
import { parseRepo } from './repo-ref.ts';
import { realRoot } from './root.ts';

/** What the workdir server is built from. */
export interface WorkdirServerOptions {
  /** The folder every checkout goes under. Made when missing. */
  root: string;
  /**
   * Runs git.
   *
   * @defaultValue `createGitRunner()`
   */
  git?: GitRunner;
}

/** The server's name, as an MCP client sees it. */
export const WORKDIR_SERVER_NAME = 'workdir';
/** The server's version, as an MCP client sees it. */
const WORKDIR_SERVER_VERSION = '1.0.0';
/** `list_dir`'s depth when the call names none: the directory's own entries. */
const DEFAULT_LIST_DEPTH = 1;

/**
 * Builds the worker's built-in MCP server, which gives each run a work directory per repo.
 *
 * @param options - The root, and the git runner.
 * @param [overrides] - Settings that replace `WORKDIR_DEFAULTS`.
 * @returns The server, not yet connected to a transport.
 *
 * @remarks
 * It offers `open_repo`, which clones a repo under the root or returns the checkout already there, and `list_dir`.
 * Nothing either tool reads or writes is outside the root, symlinks included.
 */
export function createWorkdirServer(
  options: WorkdirServerOptions,
  overrides: Partial<WorkdirSettings> = {},
): McpServer {
  const { root, git = createGitRunner() } = options;
  const settings: WorkdirSettings = { ...WORKDIR_DEFAULTS, ...overrides };
  const server = new McpServer({ name: WORKDIR_SERVER_NAME, version: WORKDIR_SERVER_VERSION });
  // One open per checkout at a time, so two calls for one repo never clone it twice.
  const opening = new Map<string, Promise<OpenedRepo>>();

  server.registerTool(
    'open_repo',
    {
      description:
        'Returns a work directory holding a checkout of a git repo, cloning it the first time. ' +
        'Answers JSON: { path, cloned, branch, head }.',
      inputSchema: {
        repo: z
          .string()
          .describe('`owner/name` on GitHub, an https clone URL, or an ssh one like `git@host:owner/name.git`.'),
      },
    },
    ({ repo }) =>
      answer(async () => {
        const ref = parseRepo(repo);
        const rootPath = await realRoot(root);
        const key = `${ref.host}/${ref.owner}/${ref.name}`;
        const pending = opening.get(key) ?? openRepo(rootPath, ref, git, settings);
        opening.set(key, pending);
        try {
          return await pending;
        } finally {
          opening.delete(key);
        }
      }),
  );

  server.registerTool(
    'list_dir',
    {
      description:
        'Lists a directory under the work root: each entry with its type (file, dir, symlink, other) and size. ' +
        `Symlinks are not followed, and .git is never listed inside. Answers JSON with \`truncated\` when it held more than ${settings.maxEntries} entries.`,
      inputSchema: {
        path: z.string().describe('Relative to the work root, or absolute inside it.'),
        depth: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`Levels to list; 1 lists the directory's own entries. At most ${settings.maxDepth}.`),
      },
    },
    ({ path, depth = DEFAULT_LIST_DEPTH }) => answer(async () => listDir(await realRoot(root), path, depth, settings)),
  );

  return server;
}

/**
 * Runs a tool's work and answers with its result as JSON, or with its failure as a tool error.
 *
 * @param work - The tool's work.
 * @returns The tool result. A failure is `isError: true` with its message, never a thrown error.
 */
async function answer(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await work();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: errorMessage(error) }], isError: true };
  }
}
