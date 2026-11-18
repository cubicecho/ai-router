import type { Request } from 'express';
import { readWorkspaceCaller } from '../auth/caller.ts';
import type { WorkspaceCaller } from '../core/context.ts';
import type { Snapshot } from '../db/snapshot.ts';

/**
 * Copies Express's headers into a fetch `Headers`, as the caller reader takes them.
 *
 * @param request - The request.
 * @returns Its headers.
 */
function headersOf(request: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      headers.set(name, value.join(', '));
    }
  }
  return headers;
}

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
