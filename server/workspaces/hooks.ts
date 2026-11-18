import type { OnWriteConfig, WriteHookPayload } from '@vantreeseba/drizzle-graphql';
import { parseOrThrow } from '../core/validation.ts';
import { rebuildAfterCommit, writtenRows } from '../graphql/write-guards.ts';
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

/** Validation and snapshot hooks for `workspaces`. */
export const workspaceWriteHooks: OnWriteConfig = {
  workspaces: {
    insert: { before: checkWorkspace, after: rebuildAfterCommit },
    update: { before: checkWorkspace, after: rebuildAfterCommit },
    delete: { after: rebuildAfterCommit },
  },
};
