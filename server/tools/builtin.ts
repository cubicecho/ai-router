import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { badInput } from '../core/errors.ts';
import type { RunToolCall } from './api.ts';
import { RESERVED_SERVER_NAME, type ResolvedServer, type ServerTransport, TRANSPORT_BUILTIN } from './shapes.ts';

/**
 * Connects an instance of the built-in server in process: the admin server, which `admin/` builds and the app hands
 * to the tools area.
 *
 * @param server - The instance's server as resolved, with its workspace and the roles it grants.
 * @returns The client's end of a transport whose other end the admin server is already serving.
 */
export type BuiltinConnector = (server: ResolvedServer) => Promise<Transport>;

/** The `_meta` key a call to the admin server names its run under. */
export const RUN_META_KEY = 'ai-router/run';

/** The run a call to the admin server is for, as `_meta` carries it. */
const runMetaSchema = z.object({
  runId: z.string().min(1),
  agentId: z.string().min(1),
  /** The depth an agent a call through it would start is at: `RunToolCall.depth`. */
  depth: z.number().int().nonnegative(),
});
/** The run a call to the admin server is for. */
export type RunMeta = z.infer<typeof runMetaSchema>;

/** What a person is told when they try to give a server the built-in transport or source. */
export const BUILTIN_ONLY = `The built-in transport is the router's own: only "${RESERVED_SERVER_NAME}" has it.`;

/** Why an agent run may not change or restart the admin server: it is the run's own way in. */
export const BUILTIN_PEOPLE_ONLY = 'only a person changes or restarts it, never an agent run through it';

/** Why an agent run may not try the admin server's tools through it: it calls them directly. */
export const BUILTIN_RUNS_DIRECT = 'a run calls its tools directly, not through try_server_tool';

/** The admin server's columns a write may change. Everything else about it is the router's. */
export const BUILTIN_EDITABLE: ReadonlySet<string> = new Set(['enabled', 'displayName', 'description', 'updatedAt']);

/**
 * Whether a server is the built-in admin server.
 *
 * @param server - The server, or anything holding its transport.
 * @returns true for `ai-router`.
 */
export function isBuiltin(server: { transport: Pick<ServerTransport, 'type'> }): boolean {
  return server.transport.type === TRANSPORT_BUILTIN;
}

/**
 * Refuses something the admin server never has done to it.
 *
 * @param server - The server about to be acted on.
 * @param why - What it lacks, finishing "ai-router is built in: …".
 * @throws BAD_USER_INPUT for the admin server.
 */
export function refuseIfBuiltin(server: { transport: Pick<ServerTransport, 'type'> }, why: string): void {
  if (isBuiltin(server)) {
    throw badInput(`"${RESERVED_SERVER_NAME}" is built in: ${why}.`);
  }
}

/**
 * Builds the `_meta` a call to the admin server carries, so it acts as the run that made it.
 *
 * @param run - The run.
 * @returns The `_meta` object. Set by the router's own dispatch, never by the model.
 */
export function runMeta(run: RunToolCall): Record<string, RunMeta> {
  return { [RUN_META_KEY]: { runId: run.runId, agentId: run.agentId, depth: run.depth } };
}

/**
 * Reads the run a call to the admin server names.
 *
 * @param meta - The request's `_meta`, as the MCP SDK hands it over.
 * @returns The run, or null for a call that names none.
 */
export function readRunMeta(meta: unknown): RunMeta | null {
  const parsed = z.object({ [RUN_META_KEY]: runMetaSchema }).safeParse(meta);
  return parsed.success ? parsed.data[RUN_META_KEY] : null;
}
