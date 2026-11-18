import { createHash } from 'node:crypto';
import { toolName } from '../tools/naming.ts';

/** The longest function name OpenAI accepts. */
const MAX_FUNCTION_NAME_LENGTH = 64;
/** Hex characters of the hash that ends a name which had to be cut or told apart. */
const HASH_CHARS = 8;
/** What joins a cut name to its hash. */
const HASH_JOIN = '_';
/** Every character an OpenAI function name may not hold: it allows only `[a-zA-Z0-9_-]`. */
const INVALID_CHARS = /[^a-zA-Z0-9_-]/g;
/** What an invalid character becomes. */
const REPLACEMENT = '_';

/** One of a run's tools: which server it is on, and its own name there. */
export interface RunTool {
  serverId: string;
  serverName: string;
  /** The tool's name at its server. */
  tool: string;
}

/**
 * What naming a run's tools gave.
 *
 * @typeParam T - The tools as given, with whatever else they carry.
 */
export interface RunToolNames<T extends RunTool> {
  /** By the function name the model sees, each back to its server and tool. */
  names: Map<string, T>;
  /** Tools left out, because their name could not be told apart from another's. */
  dropped: T[];
}

/**
 * Cuts a name short enough to take its hash, and adds the hash of the name it stands for.
 *
 * @param valid - The name with every invalid character replaced.
 * @param original - `<server>__<tool>` as the router names it, which the hash is of.
 * @returns At most 64 characters, ending in `_` and eight hex characters.
 */
function withHash(valid: string, original: string): string {
  const hash = createHash('sha256').update(original).digest('hex').slice(0, HASH_CHARS);
  return `${valid.slice(0, MAX_FUNCTION_NAME_LENGTH - HASH_CHARS - HASH_JOIN.length)}${HASH_JOIN}${hash}`;
}

/**
 * Names a run's tools as a model accepts them, and keeps the way back to each one.
 *
 * @typeParam T - The tools as given, with whatever else they carry.
 * @param tools - Every tool the run reaches.
 * @returns The names, and any tool that had to be left out.
 *
 * @remarks
 * A tool is named `<server>__<tool>`, with each character OpenAI refuses replaced by `_`. A name longer than 64
 * characters, or one that two tools come to share, is cut and ends in `_` and the first 8 hex characters of the
 * SHA-256 of `<server>__<tool>`. A name that needed no change keeps it, even beside a changed name that collides
 * with it. The same tools always get the same names, whatever order they are listed in.
 */
export function runToolNames<T extends RunTool>(tools: readonly T[]): RunToolNames<T> {
  const entries = tools
    .map((tool) => {
      const original = toolName(tool.serverName, tool.tool);
      const valid = original.replace(INVALID_CHARS, REPLACEMENT);
      const fits = valid.length <= MAX_FUNCTION_NAME_LENGTH;
      return { tool, original, valid, candidate: fits ? valid : withHash(valid, original) };
    })
    .sort((a, b) => (a.original < b.original ? -1 : Number(a.original > b.original)));
  const sharing = new Map<string, number>();
  for (const { candidate } of entries) {
    sharing.set(candidate, (sharing.get(candidate) ?? 0) + 1);
  }
  const names = new Map<string, T>();
  const dropped: T[] = [];
  for (const { tool, original, valid, candidate } of entries) {
    const isShared = (sharing.get(candidate) ?? 0) > 1;
    const isUnchanged = candidate === original;
    const name = isShared && isUnchanged === false ? withHash(valid, original) : candidate;
    if (names.has(name)) {
      dropped.push(tool);
      continue;
    }
    names.set(name, tool);
  }
  return { names, dropped };
}
