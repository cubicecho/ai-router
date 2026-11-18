import type { WriteHookPayload } from '@vantreeseba/drizzle-graphql';
import type { Context } from '../core/context.ts';

/** One written row: column values by TS key. */
export type Row = Record<string, unknown>;

/** The arguments a generated write carries rows in. */
interface WriteArgs {
  /** Rows on create. */
  values?: Row | Row[];
  /** The changed columns on update. */
  set?: Row;
}

/**
 * Collects the rows a generated write supplies.
 *
 * @param args - The mutation's arguments.
 * @returns One row per written set.
 */
export function writtenRows(args: WriteArgs): Row[] {
  if (args.values !== undefined) {
    return Array.isArray(args.values) ? args.values : [args.values];
  }
  return args.set === undefined ? [] : [args.set];
}

/**
 * Rebuilds the snapshot once a write commits, so requests route by it. An `after` hook for every table it holds.
 *
 * @param payload - The write that just ran.
 */
export function rebuildAfterCommit({ context, onCommit }: WriteHookPayload): void {
  const { snapshot }: Context = context;
  onCommit(() => snapshot.rebuild());
}
