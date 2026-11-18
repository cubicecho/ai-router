import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { childUidInRange, servers } from './servers.ts';
import { workspaces } from './workspaces.ts';

/**
 * A server entry: how one server is configured for the agent runs one workspace starts, such as one
 * household's budget login. It never adds the server to a run; the agent decides that. A workspace
 * with no entry for a server uses its base instance. Secret overrides are in `server_secrets`.
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
  ],
);

/** A server entry row as read. */
export type WorkspaceServer = typeof workspaceServers.$inferSelect;
