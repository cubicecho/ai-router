import { mkdirSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { WORKER_KEY_PREFIX } from '../server/auth/keys.ts';
import { errorMessage } from '../server/core/errors.ts';

/** Where the work root is when `WORKER_ROOT` is unset, under the worker user's home. */
const DEFAULT_ROOT_FOLDER = 'ai-router-work';
/** What a path starting with the home folder starts with. */
const HOME_PREFIX = '~/';
/** A lone `~`: the home folder itself. */
const HOME = '~';

/** A local server the worker starts itself: a command, run as the worker's user. */
const commandServerSchema = z.strictObject({
  command: z.string().min(1, 'A server\'s "command" cannot be empty.'),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /** Relative to the config file's folder. */
  cwd: z.string().min(1).optional(),
});
export type CommandServerConfig = z.infer<typeof commandServerSchema>;

/** A local server the worker reaches at an address, over streamable HTTP. */
const addressServerSchema = z.strictObject({
  url: z.url('A server\'s "url" must be an absolute URL.'),
  headers: z.record(z.string(), z.string()).optional(),
});
export type AddressServerConfig = z.infer<typeof addressServerSchema>;

/** One of the servers `WORKER_CONFIG` names. */
const localServerConfigSchema = z.union([commandServerSchema, addressServerSchema]);
export type LocalServerConfig = z.infer<typeof localServerConfigSchema>;

/** The file `WORKER_CONFIG` points at. */
const workerFileSchema = z.strictObject({
  servers: z.record(z.string(), localServerConfigSchema).default({}),
});

/** The environment the worker reads. */
const workerEnvSchema = z.object({
  AI_ROUTER_URL: z.url('AI_ROUTER_URL must be the router\'s address, such as "http://router.lan:3000".'),
  AI_ROUTER_WORKER_KEY: z
    .string({ error: 'AI_ROUTER_WORKER_KEY is required: the key shown when the worker was made in the router.' })
    .startsWith(WORKER_KEY_PREFIX, `AI_ROUTER_WORKER_KEY must be a worker key, which starts "${WORKER_KEY_PREFIX}".`),
  WORKER_ROOT: z.string().optional(),
  WORKER_CONFIG: z.string().optional(),
  WORKER_HOST: z.string().optional(),
});

/** What the worker program runs with. */
export interface WorkerConfig {
  /** The router's address, with no trailing slash. */
  url: string;
  /** The worker key it dials in with. Never logged. */
  key: string;
  /** The folder its work directories go under. Exists once the config is read. */
  root: string;
  /** The machine it says it runs on. */
  host: string;
  /** Its own servers, by name, with each command server's `cwd` made absolute. */
  servers: Record<string, LocalServerConfig>;
}

/** The worker's environment or config file is wrong: the message says which variable or file, and how to fix it. */
export class WorkerConfigError extends Error {
  /**
   * @param message - What is wrong, and what to set.
   */
  constructor(message: string) {
    super(message);
    this.name = 'WorkerConfigError';
  }
}

/**
 * Turns a leading `~` into the home folder, and a relative path into an absolute one.
 *
 * @param path - The path as written.
 * @param base - What a relative path is relative to.
 * @returns The absolute path.
 */
function absolutePath(path: string, base: string): string {
  if (path === HOME) {
    return homedir();
  }
  if (path.startsWith(HOME_PREFIX)) {
    return join(homedir(), path.slice(HOME_PREFIX.length));
  }
  return isAbsolute(path) ? path : resolve(base, path);
}

/**
 * Words a zod failure as one line per problem.
 *
 * @param error - The failure.
 * @returns The problems, each with where it is.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const where = issue.path.join('.');
      return where === '' ? issue.message : `${where}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * Reads the servers file.
 *
 * @param path - The file, absolute.
 * @returns Its servers, each command server's `cwd` made absolute against the file's folder.
 * @throws WorkerConfigError when the file is missing, isn't JSON or doesn't match the shape.
 */
function readServersFile(path: string): Record<string, LocalServerConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new WorkerConfigError(`WORKER_CONFIG names ${path}, which can't be read as JSON: ${errorMessage(error)}`);
  }
  const parsed = workerFileSchema.safeParse(raw);
  if (parsed.success === false) {
    throw new WorkerConfigError(
      `WORKER_CONFIG names ${path}, which should be { "servers": { "<name>": { "command", "args"?, "env"?, "cwd"? } | { "url", "headers"? } } }:\n${describeIssues(parsed.error)}`,
    );
  }
  const folder = dirname(path);
  return Object.fromEntries(
    Object.entries(parsed.data.servers).map(([name, server]) => {
      if ('command' in server && server.cwd !== undefined) {
        return [name, { ...server, cwd: absolutePath(server.cwd, folder) }];
      }
      return [name, server];
    }),
  );
}

/**
 * Reads the worker's config from its environment, and makes its work root.
 *
 * @param env - The environment, `process.env` at boot.
 * @param cwd - What relative paths in it are relative to.
 * @returns The config.
 * @throws WorkerConfigError naming the variable or file that is wrong.
 */
export function readWorkerConfig(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): WorkerConfig {
  const parsed = workerEnvSchema.safeParse(env);
  if (parsed.success === false) {
    throw new WorkerConfigError(describeIssues(parsed.error));
  }
  const { AI_ROUTER_URL, AI_ROUTER_WORKER_KEY, WORKER_ROOT, WORKER_CONFIG, WORKER_HOST } = parsed.data;
  const root = absolutePath(WORKER_ROOT || join(homedir(), DEFAULT_ROOT_FOLDER), cwd);
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    throw new WorkerConfigError(`WORKER_ROOT is ${root}, which can't be made: ${errorMessage(error)}`);
  }
  const servers = WORKER_CONFIG ? readServersFile(absolutePath(WORKER_CONFIG, cwd)) : {};
  return {
    url: AI_ROUTER_URL.replace(/\/+$/, ''),
    key: AI_ROUTER_WORKER_KEY,
    root,
    host: WORKER_HOST || hostname(),
    servers,
  };
}
