import { headersOf } from '@/models/headers';

/**
 * A server's JSON columns, read into the shapes the server stores them in. The API serves them as
 * plain JSON, so each reader checks what it takes and drops what it doesn't know.
 */

/** Where a server came from. */
export type ServerSource =
  | { type: 'registry'; registry: string; serverName: string; version?: string | undefined }
  | { type: 'npm' | 'pypi'; package: string; version?: string | undefined }
  | { type: 'manual' }
  | { type: 'builtin' };

/** How the router reaches a server. */
export type ServerTransport =
  | { type: 'stdio'; command: string; args: string[] }
  | { type: 'streamable-http'; url: string }
  | { type: 'builtin' };

/** What the UI knows about one env var, from the registry's description of it. */
export interface EnvVarMeta {
  description?: string | undefined;
  isRequired?: boolean | undefined;
  isSecret?: boolean | undefined;
  placeholder?: string | undefined;
}

/** A program the router starts. */
export const STDIO = 'stdio' as const;
/** A server reached at an address. */
export const STREAMABLE_HTTP = 'streamable-http' as const;
/** The router's own admin server, `ai-router`, served inside it. */
export const BUILTIN = 'builtin' as const;

/**
 * Reads a JSON value as an object.
 *
 * @param value - Anything.
 * @returns Its entries when it is a plain object; otherwise none.
 */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Reads a JSON value as a string.
 *
 * @param value - Anything.
 * @returns It when it is a string; otherwise an empty one.
 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Reads a JSON value as a list of strings.
 *
 * @param value - Anything.
 * @returns The strings in it, in order.
 */
export function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Reads a server's `source`.
 *
 * @param value - The `source` field.
 * @returns Where it came from; anything unknown reads as added by hand.
 */
export function sourceOf(value: unknown): ServerSource {
  const source = recordOf(value);
  const version = typeof source.version === 'string' ? source.version : undefined;
  if (source.type === 'registry') {
    return { type: 'registry', registry: textOf(source.registry), serverName: textOf(source.serverName), version };
  }
  if (source.type === 'npm' || source.type === 'pypi') {
    return { type: source.type, package: textOf(source.package), version };
  }
  if (source.type === BUILTIN) {
    return { type: BUILTIN };
  }
  return { type: 'manual' };
}

/**
 * Reads a server's `transport`.
 *
 * @param value - The `transport` field.
 * @returns How it is reached.
 */
export function transportOf(value: unknown): ServerTransport {
  const transport = recordOf(value);
  if (transport.type === STREAMABLE_HTTP) {
    return { type: STREAMABLE_HTTP, url: textOf(transport.url) };
  }
  if (transport.type === BUILTIN) {
    return { type: BUILTIN };
  }
  return { type: STDIO, command: textOf(transport.command), args: stringsOf(transport.args) };
}

/**
 * Whether a server is the router's own admin server, which nobody edits, deletes or gives secrets.
 *
 * @param transport - The server's `transport` field, as the API serves it.
 * @returns true for `ai-router`.
 */
export function isBuiltin(transport: unknown): boolean {
  return transportOf(transport).type === BUILTIN;
}

/**
 * Reads a server's or entry's `env`: an object of strings.
 *
 * @param value - The `env` field.
 * @returns The values by name.
 */
export function envOf(value: unknown): Record<string, string> {
  return headersOf(value);
}

/**
 * Reads a server's `envMeta`.
 *
 * @param value - The `envMeta` field.
 * @returns What is known of each env var, by name.
 */
export function envMetaOf(value: unknown): Record<string, EnvVarMeta> {
  return Object.fromEntries(
    Object.entries(recordOf(value)).map(([name, raw]) => {
      const meta = recordOf(raw);
      return [
        name,
        {
          description: typeof meta.description === 'string' ? meta.description : undefined,
          isRequired: meta.isRequired === true,
          isSecret: meta.isSecret === true,
          placeholder: typeof meta.placeholder === 'string' ? meta.placeholder : undefined,
        },
      ];
    }),
  );
}

/**
 * Says where a server came from, in a few words.
 *
 * @param source - Its source.
 * @returns Such as "npm: @scope/pkg@1.2.0" or "Added by hand".
 */
export function describeSource(source: ServerSource): string {
  const at = (version: string | undefined) => (version === undefined ? '' : `@${version}`);
  if (source.type === 'registry') {
    return `${source.registry}: ${source.serverName}${at(source.version)}`;
  }
  if (source.type === 'npm') {
    return `npm: ${source.package}${at(source.version)}`;
  }
  if (source.type === 'pypi') {
    return `PyPI: ${source.package}${at(source.version)}`;
  }
  if (source.type === BUILTIN) {
    return 'Built in';
  }
  return 'Added by hand';
}

/** What each transport is called, in a few words. */
const TRANSPORT_NAMES: Readonly<Record<ServerTransport['type'], string>> = Object.freeze({
  [STDIO]: 'Program',
  [STREAMABLE_HTTP]: 'Address',
  [BUILTIN]: 'Inside the router',
});

/**
 * Says how a server is reached, in a few words.
 *
 * @param transport - Its transport.
 * @returns "Program", "Address" or "Inside the router".
 */
export function describeTransport(transport: ServerTransport): string {
  return TRANSPORT_NAMES[transport.type];
}

/**
 * Writes a program and its arguments as one line, quoting an argument with a space in it.
 *
 * @param transport - A stdio transport.
 * @returns Such as `node dist/index.js --port 3`.
 */
export function commandLine(transport: { command: string; args: readonly string[] }): string {
  return [transport.command, ...transport.args]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(' ');
}

/**
 * Writes a list as text, one item per line.
 *
 * @param lines - The items.
 * @returns The text.
 */
export function linesToText(lines: readonly string[]): string {
  return lines.join('\n');
}

/**
 * Reads a list from text, one item per line, ignoring blank lines. An item keeps its own spaces.
 *
 * @param text - The text.
 * @returns The items.
 */
export function textToLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

/** One env var per line, as a shell writes it: `NAME=value`. */
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * Writes env vars as text, one `NAME=value` per line.
 *
 * @param env - The values by name.
 * @returns The text.
 */
export function envToText(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n');
}

/** What reading env vars from text found. */
export type ParsedEnv = { env: Record<string, string>; error: null } | { env: null; error: string };

/**
 * Reads env vars from text, one `NAME=value` per line, ignoring blank lines.
 *
 * @param text - The text.
 * @returns The values by name, or the first line that isn't one.
 */
export function textToEnv(text: string): ParsedEnv {
  const env: Record<string, string> = {};
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') {
      continue;
    }
    const match = ENV_LINE.exec(line.trim());
    if (match === null) {
      return { env: null, error: `Line ${index + 1} is not NAME=value.` };
    }
    const [, name = '', value = ''] = match;
    env[name] = value;
  }
  return { env, error: null };
}

/** What a server's extra groups may be. The router, and `run-as-child` itself, refuse the same. */
const EXTRA_GROUP_RULES = Object.freeze({
  /** Below this are the system's groups, root and shadow among them. */
  firstGid: 100,
  /** The highest group id. */
  maxGid: 2_147_483_647,
  /** Servers' own ids: holding one would open another server's folder. */
  childMin: 10_000,
  childMax: 19_999,
  /** How many a server may hold. */
  max: 8,
});
/** What separates group ids as typed: commas or spaces. */
const GROUP_SEPARATOR = /[\s,]+/;
/** One group id as typed. */
const GROUP_ID = /^\d+$/;

/** What reading group ids from text found. */
export type ParsedGroups = { groups: number[]; error: null } | { groups: null; error: string };

/**
 * Writes a server's extra groups for editing.
 *
 * @param groups - The group ids, as the API lists them.
 * @returns Them, comma-separated.
 */
export function groupsToText(groups: readonly (number | null)[]): string {
  return groups.filter((gid) => gid !== null).join(', ');
}

/**
 * Reads a server's extra groups from text, by the router's rules, ignoring blanks.
 *
 * @param text - Group ids, separated by commas or spaces.
 * @returns The ids, or why they can't be.
 */
export function textToGroups(text: string): ParsedGroups {
  const { firstGid, maxGid, childMin, childMax, max } = EXTRA_GROUP_RULES;
  const groups: number[] = [];
  for (const part of text.split(GROUP_SEPARATOR).filter((piece) => piece !== '')) {
    const gid = Number(part);
    if (GROUP_ID.test(part) === false || gid > maxGid) {
      return { groups: null, error: `"${part}" is not a group id.` };
    }
    if (gid < firstGid) {
      return { groups: null, error: `Groups below ${firstGid} are the system's own, root and shadow among them.` };
    }
    if (gid >= childMin && gid <= childMax) {
      return { groups: null, error: `Groups ${childMin}–${childMax} belong to servers.` };
    }
    if (groups.includes(gid)) {
      return { groups: null, error: `${gid} is listed twice.` };
    }
    groups.push(gid);
  }
  return groups.length > max ? { groups: null, error: `At most ${max} extra groups.` } : { groups, error: null };
}

/** A server's name: the router's name rule, and what a run needs to join it to a tool's. */
export const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** The name the router keeps for its own admin server. */
const RESERVED_NAME = 'ai-router';

/**
 * Checks a server's name as the server will.
 *
 * @param name - The name, trimmed.
 * @returns What is wrong with it, or undefined.
 */
export function serverNameError(name: string): string | undefined {
  if (SERVER_NAME_PATTERN.test(name) === false) {
    return 'Lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit.';
  }
  if (name.includes('__') || name.endsWith('_')) {
    return 'It may not hold "__" or end in "_": a run names its tools <server>__<tool>.';
  }
  if (name === RESERVED_NAME) {
    return `"${RESERVED_NAME}" is the router's own admin server.`;
  }
  return undefined;
}

/** How many milliseconds are in a second, for the timeouts the forms take in seconds. */
export const MS_PER_SECOND = 1000;

/**
 * Says how long a timeout is.
 *
 * @param ms - The timeout, or null for the router's default.
 * @param fallbackMs - The router's default; null while it loads.
 * @returns Such as "5 minutes" or "90 seconds (the router's default)".
 */
export function describeTimeout(ms: number | null, fallbackMs: number | null): string {
  const value = ms ?? fallbackMs;
  if (value === null) {
    return "The router's default";
  }
  const seconds = Math.round(value / MS_PER_SECOND);
  const text = seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
  return ms === null ? `${text} (the router's default)` : text;
}
