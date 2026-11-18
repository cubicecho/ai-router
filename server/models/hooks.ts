import type { OnWriteConfig, WriteHookPayload } from '@vantreeseba/drizzle-graphql';
import { parseOrThrow } from '../core/validation.ts';
import { rebuildAfterCommit, writtenRows } from '../graphql/write-guards.ts';
import { poolInput, providerInput } from './input.ts';

/**
 * Validates a provider write.
 *
 * @param payload - The write about to run.
 */
function checkProvider({ args }: WriteHookPayload): void {
  for (const row of writtenRows(args)) {
    parseOrThrow(providerInput, row);
  }
}

/**
 * Validates a pool write.
 *
 * @param payload - The write about to run.
 */
function checkPool({ args }: WriteHookPayload): void {
  for (const row of writtenRows(args)) {
    parseOrThrow(poolInput, row);
  }
}

/** Validation and snapshot hooks for providers and pools. A target is written by `setPoolTargets`. */
export const modelWriteHooks: OnWriteConfig = {
  providers: {
    insert: { before: checkProvider, after: rebuildAfterCommit },
    update: { before: checkProvider, after: rebuildAfterCommit },
    delete: { after: rebuildAfterCommit },
  },
  pools: {
    insert: { before: checkPool, after: rebuildAfterCommit },
    update: { before: checkPool, after: rebuildAfterCommit },
    delete: { after: rebuildAfterCommit },
  },
};
