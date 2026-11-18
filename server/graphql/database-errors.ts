import { defaultErrorMapper } from '@vantreeseba/drizzle-graphql';
import { badInput } from '../core/errors.ts';
import { violatedCheck, violatedUniqueIndex } from '../db/errors.ts';

/** What a caller is told when a write breaks a unique index, by the index's name. */
const UNIQUE_MESSAGES: Readonly<Record<string, string>> = {
  uq_workspaces_slug: 'A workspace with that slug already exists.',
  uq_providers_name: 'A provider with that name already exists.',
  uq_pools_name: 'A pool with that name already exists.',
  uq_servers_name: 'A server with that name already exists.',
  uq_registries_name: 'A registry with that name already exists.',
  uq_workspace_servers_workspace_id_server_id: 'This workspace already has an entry for that server.',
  uq_agents_name: 'An agent with that name already exists.',
  uq_workspace_agents_workspace_id_agent_id: 'This workspace can already run that agent.',
};

/** What a caller is told when a write would rename the admin server, or move another server onto its transport. */
const ADMIN_SERVER_KEPT =
  '"ai-router" is the built-in admin server: it keeps its name and transport, and no other server takes either.';

/** What a caller is told when a write breaks a check the input rules don't state first, by the check's name. */
const CHECK_MESSAGES: Readonly<Record<string, string>> = {
  ck_servers_name_reserved: ADMIN_SERVER_KEPT,
  ck_servers_builtin_source: ADMIN_SERVER_KEPT,
};

/**
 * Finds what a caller is told about a broken constraint.
 *
 * @param messages - Messages by constraint name.
 * @param constraint - The constraint the write broke, or null for none of this kind.
 * @returns Its message, or undefined for one with none.
 */
function messageFor(messages: Readonly<Record<string, string>>, constraint: string | null): string | undefined {
  return constraint === null ? undefined : messages[constraint];
}

/**
 * Turns a database error a person can fix into BAD_USER_INPUT, and leaves the rest to drizzle-graphql's masking.
 *
 * @param error - What a generated resolver threw.
 * @returns The error the caller sees.
 */
export function mapDatabaseError(error: unknown): unknown {
  const message =
    messageFor(UNIQUE_MESSAGES, violatedUniqueIndex(error)) ?? messageFor(CHECK_MESSAGES, violatedCheck(error));
  if (message !== undefined) {
    return badInput(message);
  }
  return defaultErrorMapper(error);
}
