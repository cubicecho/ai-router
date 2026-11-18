/** Postgres's code for a unique violation. */
const PG_UNIQUE_VIOLATION = '23505';
/** Postgres's code for a check constraint violation. */
const PG_CHECK_VIOLATION = '23514';

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
  return violated(error, PG_UNIQUE_VIOLATION);
}

/**
 * Reads which check constraint a write broke.
 *
 * @param error - What the write threw.
 * @returns The check's name, or null for any other error.
 */
export function violatedCheck(error: unknown): string | null {
  return violated(error, PG_CHECK_VIOLATION);
}

/**
 * Reads which constraint of one kind a write broke.
 *
 * @param error - What the write threw.
 * @param code - The Postgres error code of that kind.
 * @returns The constraint's name, or null for any other error.
 */
function violated(error: unknown, code: string): string | null {
  const pgError = pgErrorOf(error);
  const isViolation = pgError?.code === code && typeof pgError.constraint === 'string';
  return isViolation ? String(pgError?.constraint) : null;
}
