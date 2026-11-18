import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { databaseUrl, isProduction, ROOT } from '../core/config.ts';
import { requiresSsl } from '../core/hosts.ts';
import { type Claim, claimAdvisoryLock } from './lock.ts';
import { relations } from './relations.ts';

/** Where drizzle-kit writes the migrations, committed. */
const MIGRATIONS_FOLDER = path.join(ROOT, 'drizzle');

/** The Drizzle client. node-postgres in the router; tests pass PGlite, which runs the same SQL. */
export type DB = PgAsyncDatabase<PgQueryResultHKT, typeof relations>;
/** The transaction a write and its checks run in. */
export type Transaction = Parameters<Parameters<DB['transaction']>[0]>[0];

/** The router's Postgres, and what boot and shutdown do with it. */
export interface Database {
  db: DB;
  /** Where it is, for the boot log, with no password in it. */
  location: string;
  /** Applies the committed migrations. */
  migrate: () => Promise<void>;
  /** Makes this process the database's only router, or throws. */
  claim: () => Promise<void>;
  /** Releases the claim and closes the pool, after the server has drained. */
  close: () => Promise<void>;
}

/**
 * Opens the router's Postgres. Nothing connects until the first query.
 *
 * @param [connectionString] - A postgres:// URL; preflight has checked `DATABASE_URL` is one.
 * @returns The database, not yet claimed or migrated.
 */
export function openDatabase(connectionString = databaseUrl()): Database {
  const mustForceSsl = isProduction() && requiresSsl(connectionString);
  const pool = new pg.Pool({ connectionString, ...(mustForceSsl ? { ssl: true } : {}) });
  const db = drizzle({ client: pool, relations });
  const url = new URL(connectionString);
  let claim: Claim | null = null;
  return {
    db,
    location: `postgres ${url.hostname}${url.pathname}`,
    migrate: async () => {
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    },
    claim: async () => {
      claim = await claimAdvisoryLock(pool);
    },
    close: async () => {
      await claim?.release();
      await pool.end();
    },
  };
}
