import type { OnWriteConfig, WriteHookPayload } from '@vantreeseba/drizzle-graphql';
import type { Context } from '../core/context.ts';
import { parseOrThrow } from '../core/validation.ts';
import { workspaceInput } from './input.ts';

/** One written row: column values by TS key. */
type Row = Record<string, unknown>;

/** The arguments a generated workspace write carries rows in. */
interface WriteArgs {
  /** Rows on create. */
  values?: Row | Row[];
  /** The changed columns on update. */
  set?: Row;
}

/**
 * Collects the rows a write supplies.
 *
 * @param args - The mutation's arguments.
 * @returns One row per written set.
 */
function writtenRows(args: WriteArgs): Row[] {
  if (args.values !== undefined) {
    return Array.isArray(args.values) ? args.values : [args.values];
  }
  return args.set === undefined ? [] : [args.set];
}

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
 * Rebuilds the snapshot once the write commits, so the gateways route by it.
 *
 * @param payload - The write that just ran.
 */
function rebuildAfterCommit({ context, onCommit }: WriteHookPayload): void {
  const { snapshot }: Context = context;
  onCommit(() => snapshot.rebuild());
}

/** Validation and snapshot hooks for `workspaces`. */
export const workspaceWriteHooks: OnWriteConfig = {
  workspaces: {
    insert: { before: checkWorkspace, after: rebuildAfterCommit },
    update: { before: checkWorkspace, after: rebuildAfterCommit },
    delete: { after: rebuildAfterCommit },
  },
};
