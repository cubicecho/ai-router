import { inArray } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { DB } from './client.ts';

/**
 * Finds which of some ids still have their row. A count or a record written a few seconds after it
 * happened may name a row deleted since, and its foreign key would refuse the whole write.
 *
 * @param db - The database.
 * @param table - The table the ids point into.
 * @param idColumn - Its id column.
 * @param ids - The ids to look for; nulls are skipped.
 * @returns The ids that still exist.
 */
export async function existingIds(
  db: Pick<DB, 'select'>,
  table: PgTable,
  idColumn: PgColumn,
  ids: Iterable<string | null | undefined>,
): Promise<Set<string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => typeof id === 'string'))];
  if (wanted.length === 0) {
    return new Set();
  }
  const rows = await db.select({ id: idColumn }).from(table).where(inArray(idColumn, wanted));
  return new Set(rows.map((row) => String(row.id)));
}
