import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzleNode } from 'drizzle-orm/node-postgres';
import { migrate as migrateNode } from 'drizzle-orm/node-postgres/migrator';
import type { PgAsyncDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import pg from 'pg';
import { databaseUrl, dataDir, isProduction, ROOT, usesPostgres } from '../core/config.ts';
import { requiresSsl } from '../core/hosts.ts';
import { type Claim, claimAdvisoryLock, claimDirectory } from './lock.ts';
import { relations } from './relations.ts';

/** Where drizzle-kit writes the migrations, committed. */
const MIGRATIONS_FOLDER = path.join(ROOT, 'drizzle');
/** The folder under `DATA_DIR` that PGlite keeps its database in. */
const PGLITE_FOLDER = 'pg';

/** The Drizzle client, whichever driver is under it. Both run the same SQL against the same tables. */
export type DB = PgAsyncDatabase<PgQueryResultHKT, typeof relations>;
/** The transaction a write and its checks run in. */
export type Transaction = Parameters<Parameters<DB['transaction']>[0]>[0];

/** An open database and what boot and shutdown do with it. */
export interface Database {
  db: DB;
  /** Whether it is a Postgres server, which boot must wait for. PGlite is up once it is constructed. */
  isPostgres: boolean;
  /** Where it is, for the boot log, with no password in it. */
  location: string;
  /** Applies the committed migrations with the driver's own migrator. */
  migrate: () => Promise<void>;
  /** Makes this process the database's only router, or throws. PGlite claims its directory as it opens. */
  claim: () => Promise<void>;
  /** Releases the claim and closes the connection, after the server has drained. */
  close: () => Promise<void>;
}

/**
 * Opens node-postgres against a server.
 *
 * @param connectionString - A postgres:// URL.
 * @returns The database.
 */
function openPostgres(connectionString: string): Database {
  const mustForceSsl = isProduction() && requiresSsl(connectionString);
  const pool = new pg.Pool({ connectionString, ...(mustForceSsl ? { ssl: true } : {}) });
  const db = drizzleNode({ client: pool, relations });
  const url = new URL(connectionString);
  let claim: Claim | null = null;
  return {
    db,
    isPostgres: true,
    location: `postgres ${url.hostname}${url.pathname}`,
    migrate: async () => {
      await migrateNode(db, { migrationsFolder: MIGRATIONS_FOLDER });
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

/**
 * Opens PGlite in this process.
 *
 * @param store - A data directory, or a PGlite scheme such as `memory://`.
 * @returns The database.
 * @throws When another live process holds the directory.
 */
function openPglite(store: string): Database {
  const isDirectory = store.includes('://') === false;
  if (isDirectory) {
    fs.mkdirSync(store, { recursive: true });
  }
  // Before PGlite touches the directory: a second process on it would silently fork the database.
  const claim = isDirectory ? claimDirectory(store) : null;
  const client = new PGlite(store);
  const db = drizzlePglite({ client, relations });
  return {
    db,
    isPostgres: false,
    location: `pglite ${store}`,
    migrate: async () => {
      await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
    },
    // Claimed as it was opened. A store in memory belongs to this process alone.
    claim: async () => {},
    close: async () => {
      // Flushes and closes the data directory before the lock goes.
      await client.close();
      await claim?.release();
    },
  };
}

/**
 * Opens the router's database: Postgres for a `postgres://` URL, PGlite otherwise.
 *
 * @param [url] - `DATABASE_URL`: a postgres:// URL, a PGlite store, or empty for PGlite under `DATA_DIR`.
 * @param [dir] - `DATA_DIR`, where an empty URL puts the PGlite store.
 * @returns The database, not yet migrated, and for Postgres not yet claimed.
 * @throws When another router holds the PGlite directory.
 */
export function openDatabase(url = databaseUrl(), dir = dataDir()): Database {
  if (usesPostgres(url)) {
    return openPostgres(url);
  }
  return openPglite(url === '' ? path.join(dir, PGLITE_FOLDER) : url);
}
