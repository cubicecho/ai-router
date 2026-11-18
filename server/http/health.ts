import { sql } from 'drizzle-orm';
import { version } from '../core/config.ts';
import { errorMessage } from '../core/errors.ts';
import type { DB } from '../db/client.ts';
import type { ChildIsolation, ChildMode } from '../tools/child-users.ts';

/** What `/healthz` answers. */
export interface Health {
  /** Whether the database answered a query just now. */
  ok: boolean;
  /** The release this router is running. */
  version: string;
  /** How stdio MCP servers will run: as their own users, as the router's, or not at all. */
  children: ChildMode;
  /** Why the database didn't answer. Absent when it did. */
  error?: string;
}

/**
 * Asks the database for one row, so "healthy" means a request could be served.
 *
 * @param db - The database.
 * @param children - What the boot check found about child users.
 * @returns The report; `ok` is false when the query fails.
 */
export async function checkHealth(db: DB, children: ChildIsolation): Promise<Health> {
  try {
    await db.execute(sql`select 1`);
    return { ok: true, version: version(), children: children.mode };
  } catch (error) {
    return { ok: false, version: version(), children: children.mode, error: errorMessage(error) };
  }
}
