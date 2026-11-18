import { z } from 'zod';

/** What a router name may look like: lowercase letters, digits and dashes, starting with a letter. */
const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Builds the schema for a router name: a workspace's slug, and later a provider, server or agent id.
 *
 * @param label - What the name names, as the message starts it ("Slug").
 * @param maxLength - Longest name, in characters.
 * @returns The zod schema, which trims before it checks.
 */
export function nameSchema(label: string, maxLength: number) {
  return z
    .string()
    .trim()
    .min(1, `${label} cannot be empty.`)
    .max(maxLength, `${label} is longer than ${maxLength} characters.`)
    .regex(NAME_PATTERN, `${label} may hold lowercase letters, digits and dashes, and must start with a letter.`);
}
