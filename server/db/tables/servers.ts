import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { EnvVarMeta, ServerOAuth, ServerSource, ServerTransport } from '../../tools/shapes.ts';

/** The first and last user ids a server may run as. `docker/run-as-child.c` holds the same two numbers. */
export const CHILD_UID_RANGE = Object.freeze({ min: 10_000, max: 19_999 });

/**
 * Hands each server a user id of its own. It never cycles, so an id is never handed out twice and a
 * new server can't find files an old one left behind.
 */
export const childUidSequence = pgSequence('child_uid_seq', {
  startWith: CHILD_UID_RANGE.min,
  minValue: CHILD_UID_RANGE.min,
  maxValue: CHILD_UID_RANGE.max,
  cycle: false,
});

/** An MCP server the router installed or connects to. Untrusted code: see the child-process invariants. */
export const servers = pgTable(
  'servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The router name a run's tools carry: `<name>__<tool>`. Never `ai-router`. */
    name: text('name').notNull(),
    displayName: text('display_name'),
    description: text('description').notNull().default(''),
    /** A disabled server is left out of every run, and its instances are stopped. */
    enabled: boolean('enabled').notNull().default(true),
    /** Where it came from. Set when it is added, never changed. */
    source: jsonb('source').$type<ServerSource>().notNull(),
    /** How the router reaches it. Header values are secrets, in `server_secrets`. */
    transport: jsonb('transport').$type<ServerTransport>().notNull(),
    /** Env values that aren't secret. Secret ones are in `server_secrets`. */
    env: jsonb('env').$type<Record<string, string>>().notNull().default({}),
    /** What the UI says about each env var, from the registry. */
    envMeta: jsonb('env_meta').$type<Record<string, EnvVarMeta>>().notNull().default({}),
    /** Null for the router's default. */
    idleTimeoutMs: integer('idle_timeout_ms'),
    /** Null for the router's default. */
    callTimeoutMs: integer('call_timeout_ms'),
    /** The user id its programs and install scripts run as. Handed out once, by the sequence. */
    childUid: integer('child_uid').notNull().default(sql`nextval('child_uid_seq')`),
    /** Its own folder, made by its own user. Null until something is installed or started there. */
    installDir: text('install_dir'),
    /** A remote server's login: tokens and client. A secret: never served. */
    oauth: jsonb('oauth').$type<ServerOAuth>(),
    /** Whether the router holds a login for it: what the API serves in place of `oauth`. Kept by Postgres. */
    signedIn: boolean('signed_in').notNull().generatedAlwaysAs(sql`oauth is not null and oauth ? 'tokens'`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_servers_name').on(table.name),
    uniqueIndex('uq_servers_child_uid').on(table.childUid),
    check('ck_servers_name_reserved', sql`${table.name} <> 'ai-router'`),
    check(
      'ck_servers_child_uid_range',
      sql`${table.childUid} between ${sql.raw(String(CHILD_UID_RANGE.min))} and ${sql.raw(String(CHILD_UID_RANGE.max))}`,
    ),
  ],
);

/** A server row as read. */
export type ServerRow = typeof servers.$inferSelect;
/** A server row as inserted. */
export type NewServerRow = typeof servers.$inferInsert;
