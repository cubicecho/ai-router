import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.ts';

/** The built-in worker's name, kept for it: the agent loops that run inside the router process. */
export const LOCAL_WORKER_NAME = 'local';

/**
 * Where a workspace's agent loops run: `local`, inside the router, or a worker process on another machine that dials
 * in with its worker key. Only the key's hash is kept: the key itself exists in the answer that made it.
 */
export const workers = pgTable(
  'workers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** A router name, for people. `local` is the built-in worker's, and nobody else's. */
    name: text('name').notNull(),
    /** SHA-256 of the whole key, in hex. Null for `local` alone, which dials nothing. */
    keyHash: text('key_hash'),
    /** The key's prefix and first characters, in the clear, so people can tell keys apart. Null with no key. */
    keyPrefix: text('key_prefix'),
    /** Whether it has a key: what the API serves in place of the hash. Kept by Postgres. */
    keySet: boolean('key_set').notNull().generatedAlwaysAs(sql`key_hash is not null`),
    /** Who made it. Null for `local`, and once that user is deleted. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** When it last dialled in. Null until it has. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /** The machine it said it runs on, when it last dialled in. */
    host: text('host'),
    /** The worker's version, when it last dialled in. */
    version: text('version'),
  },
  (table) => [
    uniqueIndex('uq_workers_name').on(table.name),
    uniqueIndex('uq_workers_key_hash').on(table.keyHash),
    index('idx_workers_created_by').on(table.createdBy),
    // `local` is the one worker with no key: it runs inside the router, so nothing dials in as it.
    check('ck_workers_local_keyless', sql`(${table.name} = 'local') = (${table.keyHash} is null)`),
    check('ck_workers_key_prefix', sql`(${table.keyHash} is null) = (${table.keyPrefix} is null)`),
  ],
);

/** A worker row as read. */
export type WorkerRow = typeof workers.$inferSelect;
/** A worker row as inserted. */
export type NewWorkerRow = typeof workers.$inferInsert;
