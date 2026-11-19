import { SESSION_HEADER } from '../models/affinity.ts';
import { readKeyHeader } from './conversation.ts';

/**
 * Works out the session a run belongs to, which the runs screen groups its runs by.
 *
 * @param conversationKey - The conversation the request names, if any.
 * @param sessionHeader - The `X-Session-Id` header, if sent: agent-core sends its loop's `session` in it.
 * @returns The conversation's key, else the session header's, else null.
 * @throws {@link RequestRefusal} For an `X-Session-Id` that is empty, too long or unprintable.
 *
 * @remarks
 * Only a label: it changes nothing about the run. The conversation wins because it is the app's own name for the
 * same chat, and its history is the router's.
 */
export function readSessionKey(conversationKey: string | null, sessionHeader: string | undefined): string | null {
  return conversationKey ?? readKeyHeader(SESSION_HEADER, sessionHeader);
}
