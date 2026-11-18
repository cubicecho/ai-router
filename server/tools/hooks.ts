import type { OnWriteConfig, WriteHookPayload } from '@vantreeseba/drizzle-graphql';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Context } from '../core/context.ts';
import { parseOrThrow } from '../core/validation.ts';
import { type ServerRow, servers } from '../db/tables/servers.ts';
import { rebuildAfterCommit, writtenRows } from '../graphql/write-guards.ts';
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
 * Validation and snapshot hooks for the tools tables CRUD writes. A server is added by `installServer`
 * and removed by `deleteServer`; its secrets are written by `setServerSecret`.
 */
export const toolWriteHooks: OnWriteConfig = {
  registries: {
    insert: { before: checkWith(registryInput) },
    update: { before: checkWith(registryInput) },
  },
  servers: {
    update: { before: checkWith(serverUpdateInput), after: afterServerUpdate, columns: ['id', 'transport', 'oauth'] },
  },
  workspaceServers: {
    insert: { before: checkWith(workspaceServerInput), after: rebuildAfterCommit },
    update: { before: checkWith(workspaceServerInput), after: rebuildAfterCommit },
    delete: { after: rebuildAfterCommit },
  },
};
