import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { version } from '../server/core/config.ts';
import { errorMessage } from '../server/core/errors.ts';
import { nameSchema } from '../server/core/names.ts';
import type { LocalServer, LocalTool } from '../server/runner/protocol.ts';
import { ChildTransport, signalDirectly } from '../server/tools/child-transport.ts';
import { isToolError, toolResultContent, toolResultText } from '../server/tools/tool-result.ts';
import type { CommandServerConfig, LocalServerConfig } from './config.ts';
import { WORKER_PROGRAM_DEFAULTS, type WorkdirSettings, type WorkerProgramSettings } from './defaults.ts';
import type { GitRunner } from './workdir/git.ts';
import { createWorkdirServer, WORKDIR_SERVER_NAME } from './workdir/server.ts';

/** The variables a command server gets from the worker's own environment. Everything else comes from its config. */
export const LOCAL_ENV_ALLOWLIST: readonly string[] = Object.freeze(['PATH', 'HOME', 'LANG', 'TERM', 'USER']);

/** The worker's name, as its local servers see their client. */
const CLIENT_NAME = 'ai-router-worker';

/** The rule every local server's name is checked against: the router's own name rule. */
const serverName = nameSchema('A local server name');

/** The worker's own servers, started and listed. */
export interface LocalServers {
  /**
   * Lists the servers that started, and their tools, as the hello says them.
   *
   * @returns The servers, `workdir` first.
   */
  listing(): LocalServer[];
  /**
   * Calls one of a local server's tools.
   *
   * @param server - The server's name.
   * @param tool - The tool's own name.
   * @param args - What the model called it with.
   * @param signal - Aborted when the answer is no longer wanted.
   * @returns What the tool said, as the model reads it.
   * @throws When the server is unknown or the tool reports a failure: the model is told it.
   */
  callTool(server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string>;
  /**
   * Stops every server.
   *
   * @returns Resolves once each has stopped, or been killed.
   */
  close(): Promise<void>;
}

/** What the local servers are started with. */
export interface LocalServersOptions {
  /** The work root, for the `workdir` server. */
  root: string;
  /** The servers `WORKER_CONFIG` names. */
  servers: Readonly<Record<string, LocalServerConfig>>;
  /** Hears that a server's tools changed, after the listing is up to date. */
  onChange: () => void;
  /**
   * The environment the allowlist reads from.
   *
   * @defaultValue `process.env`
   */
  baseEnv?: NodeJS.ProcessEnv;
  /** Runs git for `workdir`. Tests pass a fake. */
  git?: GitRunner;
  /** Settings for `workdir`. */
  workdir?: Partial<WorkdirSettings>;
}

/** One started server. */
interface Started {
  client: Client;
  tools: LocalTool[];
}

/**
 * Builds the environment a command server starts with: the allowlisted variables of the worker's own, then its config's.
 *
 * @param config - The server's config.
 * @param baseEnv - The worker's environment.
 * @returns The whole environment. Nothing else reaches the program.
 */
export function commandEnv(config: CommandServerConfig, baseEnv: NodeJS.ProcessEnv): Record<string, string> {
  const inherited = LOCAL_ENV_ALLOWLIST.flatMap((key) => {
    const value = baseEnv[key];
    return value === undefined ? [] : [[key, value] as const];
  });
  return { ...Object.fromEntries(inherited), ...config.env };
}

/**
 * Builds the transport for a configured server.
 *
 * @param name - Its name, for its stderr lines.
 * @param config - Its config.
 * @param baseEnv - The worker's environment.
 * @param closeGraceMs - How long a stopping program gets after each step.
 * @returns The transport, not yet started.
 */
function transportFor(
  name: string,
  config: LocalServerConfig,
  baseEnv: NodeJS.ProcessEnv,
  closeGraceMs: number,
): Transport {
  if ('url' in config) {
    return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
  }
  const spec = {
    command: config.command,
    args: config.args ?? [],
    env: commandEnv(config, baseEnv),
    cwd: config.cwd,
    signal: signalDirectly,
  };
  return new ChildTransport(spec, closeGraceMs, (text) => {
    for (const line of text.trimEnd().split('\n')) {
      console.error(`[worker] ${name}: ${line}`);
    }
  });
}

/**
 * Lists every tool a server has, page by page.
 *
 * @param client - The connected client.
 * @param timeout - How long each page may take.
 * @returns The tools, as the hello says them.
 */
async function listTools(client: Client, timeout: number): Promise<LocalTool[]> {
  const tools: LocalTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout });
    for (const tool of page.tools) {
      tools.push({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
      });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return tools;
}

/**
 * Starts the worker's own servers: `workdir`, in process, and each configured one. A server whose name breaks the
 * router's name rule, or that fails to start, is left out with a `[worker]` line.
 *
 * @param options - The root, the configured servers, and who hears of tool changes.
 * @param [overrides] - Settings that replace `WORKER_PROGRAM_DEFAULTS`.
 * @returns The servers that started.
 *
 * @remarks
 * Configured servers run as the worker's user, on its machine: the owner's trust, not the router's sandbox.
 */
export async function startLocalServers(
  options: LocalServersOptions,
  overrides: Partial<WorkerProgramSettings> = {},
): Promise<LocalServers> {
  const { root, servers, onChange, baseEnv = process.env, git, workdir } = options;
  const settings = { ...WORKER_PROGRAM_DEFAULTS, ...overrides };
  const started = new Map<string, Started>();

  const connect = async (name: string, transport: Transport): Promise<void> => {
    const client = new Client({ name: CLIENT_NAME, version: version() });
    const entry: Started = { client, tools: [] };
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      try {
        entry.tools = await listTools(client, settings.localStartTimeoutMs);
        onChange();
      } catch (error) {
        console.warn(`[worker] could not list "${name}"'s tools again: ${errorMessage(error)}`);
      }
    });
    try {
      await client.connect(transport, { timeout: settings.localStartTimeoutMs });
      entry.tools = await listTools(client, settings.localStartTimeoutMs);
    } catch (error) {
      console.error(`[worker] leaving out the local server "${name}": it did not start: ${errorMessage(error)}`);
      await client.close().catch(() => undefined);
      return;
    }
    started.set(name, entry);
  };

  const [workdirSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createWorkdirServer({ root, ...(git === undefined ? {} : { git }) }, workdir).connect(workdirSide);
  await connect(WORKDIR_SERVER_NAME, clientSide);

  const configured = Object.entries(servers).filter(([name]) => {
    if (name === WORKDIR_SERVER_NAME) {
      console.error(`[worker] leaving out the local server "${name}": the built-in server has that name.`);
      return false;
    }
    const checked = serverName.safeParse(name);
    if (checked.success === false || checked.data !== name) {
      const why = checked.error?.issues[0]?.message ?? 'it has spaces around it.';
      console.error(`[worker] leaving out the local server "${name}": ${why}`);
      return false;
    }
    return true;
  });
  await Promise.all(
    configured.map(([name, config]) => connect(name, transportFor(name, config, baseEnv, settings.localCloseGraceMs))),
  );

  return {
    listing: () => [...started].map(([name, { tools }]) => ({ name, tools })),
    callTool: async (server, tool, args, signal) => {
      const entry = started.get(server);
      if (entry === undefined) {
        throw new Error(`This worker has no local server named "${server}".`);
      }
      const result = await entry.client.request(
        { method: 'tools/call', params: { name: tool, arguments: args } },
        CallToolResultSchema,
        { signal, timeout: settings.localToolTimeoutMs },
      );
      if (isToolError(result)) {
        throw new Error(toolResultText(result));
      }
      return toolResultContent(result);
    },
    close: async () => {
      const clients = [...started.values()].map(({ client }) => client);
      started.clear();
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
    },
  };
}
