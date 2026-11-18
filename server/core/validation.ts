import type { z } from 'zod';
import { badInput } from './errors.ts';

/** What the caller reads when a schema refuses a value and says nothing of its own. */
const INVALID = 'That input is not valid.';

/**
 * Parses with zod, turning a failure into BAD_USER_INPUT.
 *
 * @typeParam Output - What the schema parses to.
 * @param schema - The zod schema.
 * @param value - Untrusted input.
 * @returns The parsed value.
 * @throws BAD_USER_INPUT with the first issue's message.
 */
export function parseOrThrow<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value);
  if (result.success === false) {
    throw badInput(result.error.issues[0]?.message ?? INVALID);
  }
  return result.data;
}
