import type { OnWriteConfig, WriteHookPayload } from '@vantreeseba/drizzle-graphql';
import type { Context } from '../core/context.ts';
import { parseOrThrow } from '../core/validation.ts';
import { rebuildAfterCommit, writtenRows } from '../graphql/write-guards.ts';
import type { DeletedEntry } from '../tools/api.ts';
import { workspaceInput } from './input.ts';

/**
 * Validates a workspace write.
 *
 * @param payload - The write about to run.
 */
function checkWorkspace({ args }: WriteHookPayload): void {
  for (const row of writtenRows(args)) {
    parseOrThrow(workspaceInput, row);
  }
}

/**
 * Stops the workspace instances of a deleted workspace's server entries and removes their folders, once the delete
 * commits, and rebuilds the snapshot. Postgres deleted the entries with the workspace, so they are read from the
 * snapshot, which still holds them.
 *
 * @param payload - The delete that just ran, with the ids it deleted.
 */
function afterWorkspaceDelete(payload: WriteHookPayload): void {
  const { tools, snapshot }: Context = payload.context;
  const deletedIds = new Set(payload.rows.map((row: { id: string }) => row.id));
  const entries: DeletedEntry[] = [...snapshot.current().servers.values()].flatMap((server) =>
    [...server.entries].flatMap(([workspaceId, entry]) =>
      deletedIds.has(workspaceId)
        ? [{ serverId: server.id, workspaceId, childUid: entry.childUid, installDir: entry.installDir }]
        : [],
    ),
  );
  if (entries.length > 0) {
    payload.onCommit(() => tools.forgetEntries(entries));
  }
  rebuildAfterCommit(payload);
}

/** Validation and snapshot hooks for `workspaces`. */
export const workspaceWriteHooks: OnWriteConfig = {
  workspaces: {
    insert: { before: checkWorkspace, after: rebuildAfterCommit },
    update: { before: checkWorkspace, after: rebuildAfterCommit },
    delete: { after: afterWorkspaceDelete, columns: ['id'] },
  },
};
