import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { servers } from './servers.ts';
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_workspace_servers_workspace_id_server_id').on(table.workspaceId, table.serverId),
    index('idx_workspace_servers_server_id').on(table.serverId),
  ],
);

/** A server entry row as read. */
export type WorkspaceServer = typeof workspaceServers.$inferSelect;
