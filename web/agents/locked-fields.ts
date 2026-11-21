// Relative, so the node tests can load this module without the UI's `@/` alias.
import { isRecord } from '../lib/is-record.ts';

/**
 * The request fields an agent's page offers to lock, by their wire names. Any other field can be locked by name too;
 * agent-core decides which may not be (`model`, `messages` and the like), and the save says so.
 */
export const COMMON_LOCKABLE_FIELDS: readonly string[] = Object.freeze([
  'temperature',
  'max_tokens',
  'reasoning_effort',
  'top_p',
  'top_k',
  'min_p',
  'presence_penalty',
  'frequency_penalty',
  'repetition_penalty',
  'seed',
  'stop',
]);

/** How a request field is spelled on the wire: lowercase letters, digits and underscores, starting with a letter. */
const FIELD_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Reads the fields a document locks.
 *
 * @param document - An agent's document, as stored.
 * @returns Its `model.lockedFields`, strings only, in order; empty when it locks none.
 */
export function lockedFieldsOf(document: unknown): string[] {
  const model = isRecord(document) ? document.model : undefined;
  const listed = isRecord(model) ? model.lockedFields : undefined;
  return Array.isArray(listed) ? listed.filter((field): field is string => typeof field === 'string') : [];
}

/**
 * Writes a document with these fields locked, leaving everything else as it was stored.
 *
 * @param document - An agent's document, as stored.
 * @param fields - The fields to lock.
 * @returns A new document. With no fields, `model.lockedFields` is left out, which locks nothing.
 */
export function withLockedFields(
  document: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const model = isRecord(document.model) ? document.model : {};
  const { lockedFields: _previous, ...rest } = model;
  const nextModel = fields.length === 0 ? rest : { ...rest, lockedFields: [...fields] };
  return { ...document, model: nextModel };
}

/**
 * The fields the page lists: the common ones, then any other the document locks, in its order.
 *
 * @param locked - The fields locked now.
 * @returns Every field to show a switch for, each once.
 */
export function listedFields(locked: readonly string[]): string[] {
  return [...new Set([...COMMON_LOCKABLE_FIELDS, ...locked])];
}

/**
 * Reads a field name a person typed.
 *
 * @param typed - What they typed.
 * @returns The name, trimmed, or null when it isn't spelled as a request field is.
 */
export function fieldNameOf(typed: string): string | null {
  const name = typed.trim();
  return FIELD_NAME.test(name) ? name : null;
}
