import { type SQL, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
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
import { CHILD_DEFAULTS } from '../../core/defaults.ts';
import type { EnvVarMeta, ServerOAuth, ServerSource, ServerTransport } from '../../tools/shapes.ts';

/** The first and last user ids a server may run as. `docker/run-as-child.c` holds the same two numbers. */
export const CHILD_UID_RANGE = Object.freeze({ min: 10_000, max: 19_999 });

/** What a server's extra groups may be, as the table checks them: at most `max`, none below `firstGid`. */
const EXTRA_GROUP_RULES = Object.freeze({
  firstGid: CHILD_DEFAULTS.firstExtraGid,
  max: CHILD_DEFAULTS.maxExtraGroups,
});

/**
 * The child range as a Postgres range, both ends included.
 *
 * @returns `int4range(min, max, '[]')`.
 */
function childIdRange(): SQL {
  return sql`int4range(${sql.raw(String(CHILD_UID_RANGE.min))}, ${sql.raw(String(CHILD_UID_RANGE.max))}, '[]')`;
}

/**
 * The check that a uid column is in the child range.
 *
 * @param column - The column.
 * @returns The check's condition.
 */
export function childUidInRange(column: AnyPgColumn): SQL {
  return sql`${column} between ${sql.raw(String(CHILD_UID_RANGE.min))} and ${sql.raw(String(CHILD_UID_RANGE.max))}`;
}

/**
 * Hands each server, and each server entry, a user id of its own. It never cycles, so an id is never
 * handed out twice and a new server can't find files an old one left behind.
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
    /** The router name a run's tools carry: `<name>__<tool>`. `ai-router` is the admin server's, and nobody else's. */
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
    /**
     * Extra groups its programs run with, such as a mounted folder's (`users`, 100). Never a system group, a
     * child id or the router's own: `tools/input` says so, and `run-as-child` refuses it.
     */
    extraGroups: integer('extra_groups').array().notNull().default([]),
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
    // `ai-router` is the admin server, the one server with the built-in transport, which comes from the router itself.
    check('ck_servers_name_reserved', sql`(${table.name} = 'ai-router') = (${table.transport}->>'type' = 'builtin')`),
    check(
      'ck_servers_builtin_source',
      sql`(${table.transport}->>'type' = 'builtin') = (${table.source}->>'type' = 'builtin')`,
    ),
    check('ck_servers_child_uid_range', childUidInRange(table.childUid)),
    check(
      'ck_servers_extra_groups',
      sql.join(
        [
          sql`cardinality(${table.extraGroups}) <= ${sql.raw(String(EXTRA_GROUP_RULES.max))}`,
          sql`${sql.raw(String(EXTRA_GROUP_RULES.firstGid))} <= all(${table.extraGroups})`,
          sql`not (${childIdRange()} @> any(${table.extraGroups}))`,
        ],
        sql` and `,
      ),
    ),
  ],
);

/** A server row as read. */
export type ServerRow = typeof servers.$inferSelect;
/** A server row as inserted. */
export type NewServerRow = typeof servers.$inferInsert;
