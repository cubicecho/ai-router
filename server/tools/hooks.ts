import type { OnWriteConfig, WriteHookPayload } from '@vantreeseba/drizzle-graphql';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { CALLER_USER, type Context } from '../core/context.ts';
import { forbidden } from '../core/errors.ts';
import { parseOrThrow } from '../core/validation.ts';
import { type ServerRow, servers } from '../db/tables/servers.ts';
import { Role } from '../db/tables/users.ts';
import { rebuildAfterCommit, writtenRows } from '../graphql/write-guards.ts';
import type { DeletedEntry } from './api.ts';
import { registryInput, serverUpdateInput, workspaceServerInput } from './input.ts';
import { dropLoginOnMove } from './oauth/service.ts';
import { TRANSPORT_STREAMABLE_HTTP } from './shapes.ts';

/**
 * Makes a `before` hook that checks every written row against a schema.
 *
 * @param schema - What a row may hold.
 * @returns The hook.
 */
const checkWith =
  (schema: z.ZodType) =>
  ({ args }: WriteHookPayload): void => {
    for (const row of writtenRows(args)) {
      parseOrThrow(schema, row);
    }
  };

/**
 * Checks a server update, and keeps its extra groups to an admin: a group can open a host folder, or
 * a socket, to the server's code.
 *
 * @param payload - The write about to run.
 * @throws FORBIDDEN when someone other than an admin sets extra groups.
 */
function checkServerUpdate(payload: WriteHookPayload): void {
  checkWith(serverUpdateInput)(payload);
  const { caller }: Context = payload.context;
  const isAdmin = caller?.kind === CALLER_USER && caller.role === Role.Admin;
  const setsGroups = writtenRows(payload.args).some((row) => row.extraGroups !== undefined);
  if (setsGroups && isAdmin === false) {
    throw forbidden('Only an admin can set extra groups: they give the server access on the host.');
  }
}

/**
 * Drops a server's login when its address moves to another origin, so its tokens are never sent
 * somewhere else, and rebuilds the snapshot. The `after` hook of a server update.
 *
 * @param payload - The write that just ran, inside its transaction. The snapshot still holds the old rows.
 */
async function afterServerUpdate(payload: WriteHookPayload): Promise<void> {
  const { tools, snapshot }: Context = payload.context;
  const before = new Map([...snapshot.current().servers.values()].map((server) => [server.id, server]));
  const updated: Pick<ServerRow, 'id' | 'transport' | 'oauth'>[] = payload.rows;
  for (const row of updated) {
    const old = before.get(row.id)?.transport;
    if (old?.type !== TRANSPORT_STREAMABLE_HTTP || row.transport.type !== TRANSPORT_STREAMABLE_HTTP) {
      continue;
    }
    if (old.url !== row.transport.url) {
      const oauth = dropLoginOnMove(old.url, row.transport.url, row.oauth);
      await payload.tx.update(servers).set({ oauth }).where(eq(servers.id, row.id));
      payload.onCommit(() => tools.logins.forget(row.id));
    }
  }
  rebuildAfterCommit(payload);
}

/**
 * Stops the workspace instances of deleted server entries and removes their folders, once the delete commits, and
 * rebuilds the snapshot. The `after` hook of a server entry delete.
 *
 * @param payload - The delete that just ran, with the rows it deleted.
 */
function afterEntryDelete(payload: WriteHookPayload): void {
  const { tools }: Context = payload.context;
  const deleted: DeletedEntry[] = payload.rows;
  payload.onCommit(() => tools.forgetEntries(deleted));
  rebuildAfterCommit(payload);
}

/** What a server entry delete's `after` hook reads from each deleted row. */
const DELETED_ENTRY_COLUMNS = ['serverId', 'workspaceId', 'childUid', 'installDir'] as const;

/**
 * Validation and snapshot hooks for the tools tables CRUD writes. A server is added by `installServer`
 * and removed by `deleteServer`; its secrets are written by `setServerSecret`.
 */
export const toolWriteHooks: OnWriteConfig = {
  registries: {
    insert: { before: checkWith(registryInput) },
    update: { before: checkWith(registryInput) },
  },
  servers: {
    update: { before: checkServerUpdate, after: afterServerUpdate, columns: ['id', 'transport', 'oauth'] },
  },
  workspaceServers: {
    insert: { before: checkWith(workspaceServerInput), after: rebuildAfterCommit },
    update: { before: checkWith(workspaceServerInput), after: rebuildAfterCommit },
    delete: { after: afterEntryDelete, columns: DELETED_ENTRY_COLUMNS },
  },
};
