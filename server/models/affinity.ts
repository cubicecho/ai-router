import { createHash } from 'node:crypto';
import { isRecord } from '../core/is-record.ts';

/** The request header a caller may send to keep its calls on one target. */
export const SESSION_HEADER = 'x-session-id';

/** Body fields that name a session or a cache, in the order they are trusted. OpenAI's own names. */
const KEY_FIELDS = ['prompt_cache_key', 'user'] as const;

/** The chat role whose first message ends the prefix a conversation keeps. */
const USER_ROLE = 'user';

/**
 * Reads a body field that holds a key.
 *
 * @param body - The call's body.
 * @param field - The field's name.
 * @returns The field's value when it is a string that is not empty.
 */
function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Takes the start of a chat that stays the same for its whole conversation.
 *
 * @param messages - The body's `messages`.
 * @returns The messages up to and including the first user message.
 */
function conversationStart(messages: readonly unknown[]): unknown[] {
  const firstUserAt = messages.findIndex((message) => isRecord(message) && message.role === USER_ROLE);
  return firstUserAt >= 0 ? messages.slice(0, firstUserAt + 1) : [...messages];
}

/**
 * Takes the part of a prompt a server's prefix cache would reuse.
 *
 * @param body - The call's body.
 * @returns A chat's opening messages, or a completion's `prompt` or an embedding's `input`, as text; undefined when
 * the body has none.
 */
function promptPrefix(body: Record<string, unknown>): string | undefined {
  const { messages, prompt, input } = body;
  if (Array.isArray(messages)) {
    return JSON.stringify(conversationStart(messages));
  }
  const promptOrInput = prompt ?? input;
  if (promptOrInput === undefined) {
    return undefined;
  }
  return typeof promptOrInput === 'string' ? promptOrInput : JSON.stringify(promptOrInput);
}

/**
 * Works out the key that keeps related calls on the same target of a sticky pool.
 *
 * @param body - The call's body.
 * @param sessionHeader - The `X-Session-Id` header, when the caller sent one.
 * @returns The caller's own key when it gave one, else a hash of the start of its prompt; null when there is neither.
 *
 * @remarks
 * A key the caller chose wins, in the order `X-Session-Id`, `prompt_cache_key`, `user`. Otherwise calls that open
 * the same way share a key. The prompt is hashed, so an opening full of images doesn't become a megabyte key.
 */
export function affinityKey(body: Record<string, unknown>, sessionHeader: string | null): string | null {
  if (sessionHeader !== null && sessionHeader !== '') {
    return sessionHeader;
  }
  for (const field of KEY_FIELDS) {
    const key = stringField(body, field);
    if (key !== undefined) {
      return key;
    }
  }
  const prefix = promptPrefix(body);
  return prefix === undefined ? null : createHash('sha256').update(prefix).digest('hex');
}
