import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { ADMIN_ROLES, type AdminRole } from '../../core/admin-roles.ts';
import { childUidInRange, servers } from './servers.ts';
import { workspaces } from './workspaces.ts';

/**
 * A workspace server: the row puts a server in a workspace, so every agent there reaches it unless it is turned off for
 * that agent (`workspace_agent_disabled_servers`). It also configures the server for that workspace's runs, such as one
 * household's budget login; a row that overrides nothing runs the base instance. Only a person adds or removes one.
 * Secret overrides are in `server_secrets`.
 */
export const workspaceServers = pgTable(
  'workspace_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    /** Env values merged over the server's own. Secret ones are in `server_secrets`. */
    env: jsonb('env').$type<Record<string, string>>().notNull().default({}),
    /** Replaces a stdio server's arguments when set. */
    args: jsonb('args').$type<string[]>(),
    /** Replaces an HTTP server's address when set. */
    url: text('url'),
    /**
     * The user id its workspace instance runs as, with the server's group, so no other instance of the server can
     * read its environment. Handed out once, by the same sequence as servers' ids.
     */
    childUid: integer('child_uid').notNull().default(sql`nextval('child_uid_seq')`),
    /** Its workspace instance's own folder, made by that uid. Null until the instance first starts. */
    installDir: text('install_dir'),
    /** For the admin server `ai-router` only: what the workspace's agent runs may do through it. Empty grants nothing. */
    roles: text('roles').$type<AdminRole>().array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_workspace_servers_workspace_id_server_id').on(table.workspaceId, table.serverId),
    index('idx_workspace_servers_server_id').on(table.serverId),
    uniqueIndex('uq_workspace_servers_child_uid').on(table.childUid),
    check('ck_workspace_servers_child_uid_range', childUidInRange(table.childUid)),
    check(
      'ck_workspace_servers_roles',
      sql`${table.roles} <@ array[${sql.raw(ADMIN_ROLES.map((role) => `'${role}'`).join(', '))}]::text[]`,
    ),
  ],
);

/** A workspace server row as read. */
export type WorkspaceServer = typeof workspaceServers.$inferSelect;
