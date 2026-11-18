/**
 * What separates a server's name from its tool's in the name a run sees. A tool's own name may hold it; a server's
 * name never does (see `isJoinableServerName`).
 */
export const TOOL_SEPARATOR = '__';

/** The one character the separator is made of. */
const SEPARATOR_CHAR = '_';

/** A run's tool name taken apart. */
export interface SplitToolName {
  serverName: string;
  /** The tool's name at its server. May itself hold `__`. */
  tool: string;
}

/**
 * Builds the name a run sees a server's tool by.
 *
 * @param serverName - The server.
 * @param tool - The tool's name at the server.
 * @returns `<server>__<tool>`.
 */
export function toolName(serverName: string, tool: string): string {
  return `${serverName}${TOOL_SEPARATOR}${tool}`;
}

/**
 * Takes a run's tool name apart at its first `__`.
 *
 * @param name - A name built by `toolName`.
 * @returns The server's name and the tool's, or null when there is no `__` or nothing on either side of it.
 *
 * @remarks
 * Splitting at the first `__` gives back what `toolName` joined only for a server name that `isJoinableServerName`
 * accepts. A tool's name may hold `__` anywhere, since everything after the first one is the tool's.
 */
export function splitToolName(name: string): SplitToolName | null {
  const separatorAt = name.indexOf(TOOL_SEPARATOR);
  const tool = name.slice(separatorAt + TOOL_SEPARATOR.length);
  const isSplittable = separatorAt > 0 && tool !== '';
  return isSplittable ? { serverName: name.slice(0, separatorAt), tool } : null;
}

/**
 * Whether a server's tools can be named after it and split back again.
 *
 * @param serverName - A name that already passes the router's name rule.
 * @returns false for a name holding `__`, or ending in `_`, whose last `_` would join the separator after it
 * (`a_` and `b` give `a___b`, which splits as `a` and `_b`).
 *
 * @remarks
 * The router's name rule allows both, so the server-name check has to refuse them as well.
 */
export function isJoinableServerName(serverName: string): boolean {
  const holdsSeparator = serverName.includes(TOOL_SEPARATOR);
  const endsInSeparatorChar = serverName.endsWith(SEPARATOR_CHAR);
  return holdsSeparator === false && endsInSeparatorChar === false;
}
