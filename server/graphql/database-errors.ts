import { defaultErrorMapper } from '@vantreeseba/drizzle-graphql';
import { badInput } from '../core/errors.ts';

/** Postgres's code for a unique violation. */
const PG_UNIQUE_VIOLATION = '23505';

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

/** The parts of a driver error this reads. */
interface PgErrorFields {
  code?: unknown;
  constraint?: unknown;
}

/**
 * Finds the Postgres error under whatever wrapped it.
 *
 * @param error - What a generated resolver threw. Drizzle puts the driver's error on `cause`.
 * @returns The driver error's fields, or null when there is none.
 */
function pgErrorOf(error: unknown): PgErrorFields | null {
  for (let current: unknown = error; typeof current === 'object' && current !== null; ) {
    if ('constraint' in current) {
      return current;
    }
    current = 'cause' in current ? current.cause : 'originalError' in current ? current.originalError : null;
  }
  return null;
}

/**
 * Turns a database error a person can fix into BAD_USER_INPUT, and leaves the rest to drizzle-graphql's masking.
 *
 * @param error - What a generated resolver threw.
 * @returns The error the caller sees.
 */
export function mapDatabaseError(error: unknown): unknown {
  const pgError = pgErrorOf(error);
  const isUniqueViolation = pgError?.code === PG_UNIQUE_VIOLATION && typeof pgError.constraint === 'string';
  if (isUniqueViolation) {
    const message = UNIQUE_MESSAGES[String(pgError?.constraint)];
    if (message !== undefined) {
      return badInput(message);
    }
  }
  return defaultErrorMapper(error);
}
