import type { OnWriteConfig, WriteHookPayload } from '@vantreeseba/drizzle-graphql';
import type { Context } from '../core/context.ts';
import { badInput } from '../core/errors.ts';
import { parseOrThrow } from '../core/validation.ts';
import { rebuildAfterCommit, writtenRows } from '../graphql/write-guards.ts';
import type { DeletedEntry } from '../tools/api.ts';
import { workspaceInput } from './input.ts';

/** What a person is told when a generated write names a workspace's worker. */
const WORKER_BY_ITS_OWN = "Set a workspace's worker with setWorkspaceWorker.";

/**
 * Validates a workspace write. Its worker is set only by `setWorkspaceWorker`, which stores `local` as none.
 *
 * @param payload - The write about to run.
 * @throws BAD_USER_INPUT for a row that breaks the input rules or names a worker.
 */
function checkWorkspace({ args }: WriteHookPayload): void {
  for (const row of writtenRows(args)) {
    if ('workerId' in row) {
      throw badInput(WORKER_BY_ITS_OWN);
    }
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
