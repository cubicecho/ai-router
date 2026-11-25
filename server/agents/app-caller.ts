import type { Request } from 'express';
import { readWorkspaceCaller } from '../auth/caller.ts';
import type { WorkspaceCaller } from '../core/context.ts';
import { headersOf } from '../core/headers.ts';
import type { Snapshot } from '../db/snapshot.ts';

/**
 * Reads the app a request to `/v1` or `/runs` is from, by its workspace key alone. A session is never read here.
 *
 * @param snapshot - What keys are checked against.
 * @param request - The request.
 * @param now - The time to judge a key's expiry by.
 * @returns The key's workspace, or null for a request without a live key.
 * @throws {@link ConflictingKeysError} When the request sends two different keys.
 */
export function appCaller(snapshot: Snapshot, request: Request, now: Date): WorkspaceCaller | null {
  return readWorkspaceCaller(snapshot, headersOf(request), now);
}
