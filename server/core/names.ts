import { z } from 'zod';
import { NAME_DEFAULTS } from './defaults.ts';

/**
 * What a router name may look like: lowercase letters, digits, dots, dashes and underscores,
 * starting with a letter or digit. llm-router and mcp-router use the same rule.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Builds the schema for a router name: a workspace's slug, a provider's or pool's name, and later a
 * server's or agent's.
 *
 * @param label - What the name names, as the message starts it ("Slug").
 * @returns The zod schema, which trims before it checks.
 */
export function nameSchema(label: string) {
  const { maxLength } = NAME_DEFAULTS;
  return z
    .string()
    .trim()
    .min(1, `${label} cannot be empty.`)
    .max(maxLength, `${label} is longer than ${maxLength} characters.`)
    .regex(
      NAME_PATTERN,
      `${label} may hold lowercase letters, digits, dots, dashes and underscores, and must start with a letter or digit.`,
    );
}
