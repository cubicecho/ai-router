/** Postgres's code for a unique violation. */
const PG_UNIQUE_VIOLATION = '23505';

/** The parts of a driver error this reads. */
interface PgErrorFields {
  code?: unknown;
  constraint?: unknown;
}

/**
 * Finds the Postgres error under whatever wrapped it.
 *
 * @param error - What a query threw. Drizzle puts the driver's error on `cause`, and GraphQL on `originalError`.
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
 * Reads which unique index a write broke.
 *
 * @param error - What the write threw.
 * @returns The index's name, or null for any other error.
 */
export function violatedUniqueIndex(error: unknown): string | null {
  const pgError = pgErrorOf(error);
  const isUniqueViolation = pgError?.code === PG_UNIQUE_VIOLATION && typeof pgError.constraint === 'string';
  return isUniqueViolation ? String(pgError?.constraint) : null;
}
