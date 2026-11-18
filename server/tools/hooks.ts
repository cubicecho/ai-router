import type { OnWriteConfig, WriteHookPayload } from '@vantreeseba/drizzle-graphql';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { CALLER_RUN, CALLER_USER, type Context } from '../core/context.ts';
import { badInput, forbidden } from '../core/errors.ts';
import { parseOrThrow } from '../core/validation.ts';
import { type ServerRow, servers } from '../db/tables/servers.ts';
import { Role } from '../db/tables/users.ts';
import type { WorkspaceServer } from '../db/tables/workspace-servers.ts';
import { rebuildAfterCommit, writtenRows } from '../graphql/write-guards.ts';
import type { DeletedEntry } from './api.ts';
import { BUILTIN_EDITABLE, BUILTIN_PEOPLE_ONLY, isBuiltin, refuseIfBuiltin } from './builtin.ts';
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
 * Refuses a change to the admin server past its display name, description and whether it is on, and any change to it
 * by an agent run, which would be switching off or renaming its own way in. Its name and transport are kept by
 * `ck_servers_name_reserved` before this runs.
 *
 * @param payload - The write that just ran. Throwing rolls it back.
 * @param updated - The rows it changed.
 * @throws BAD_USER_INPUT when it changed anything else about the admin server, or a run changed it at all.
 */
function checkBuiltinUpdate(payload: WriteHookPayload, updated: readonly Pick<ServerRow, 'transport'>[]): void {
  const { caller }: Context = payload.context;
  const changesMore = writtenRows(payload.args).some((row) =>
    Object.keys(row).some((column) => BUILTIN_EDITABLE.has(column) === false),
  );
  for (const row of updated) {
    if (caller?.kind === CALLER_RUN) {
      refuseIfBuiltin(row, BUILTIN_PEOPLE_ONLY);
    }
    if (changesMore) {
      refuseIfBuiltin(row, 'only whether it is on, its display name and its description change');
    }
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
  checkBuiltinUpdate(payload, updated);
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

/** What a server entry write's `after` hook reads from each written row. */
const WRITTEN_ENTRY_COLUMNS = ['serverId', 'env', 'args', 'url', 'roles'] as const;

/** A server entry as its write's `after` hook reads it. */
type WrittenEntry = Pick<WorkspaceServer, (typeof WRITTEN_ENTRY_COLUMNS)[number]>;

/**
 * Checks each written entry against its server: roles go only on the admin server's entries, which take nothing
 * else. Then rebuilds the snapshot. The `after` hook of a server entry insert or update.
 *
 * @param payload - The write that just ran. Throwing rolls it back.
 * @throws BAD_USER_INPUT for roles on another server's entry, or env, arguments or an address on the admin server's.
 */
function afterEntryWrite(payload: WriteHookPayload): void {
  const { snapshot }: Context = payload.context;
  const written: WrittenEntry[] = payload.rows;
  for (const entry of written) {
    const server = [...snapshot.current().servers.values()].find((candidate) => candidate.id === entry.serverId);
    if (server === undefined) {
      continue;
    }
    if (isBuiltin(server)) {
      const configuresMore = Object.keys(entry.env).length > 0 || entry.args !== null || entry.url !== null;
      if (configuresMore) {
        throw badInput(`An entry for "${server.name}" grants roles only: it takes no env, arguments or address.`);
      }
    } else if (entry.roles.length > 0) {
      throw badInput(`Roles are for the admin server's entries only, and "${server.name}" is not it.`);
    }
  }
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
    insert: { before: checkWith(workspaceServerInput), after: afterEntryWrite, columns: WRITTEN_ENTRY_COLUMNS },
    update: { before: checkWith(workspaceServerInput), after: afterEntryWrite, columns: WRITTEN_ENTRY_COLUMNS },
    delete: { after: afterEntryDelete, columns: DELETED_ENTRY_COLUMNS },
  },
};
