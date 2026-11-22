import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { servers } from './servers.ts';
import { workspaceAgents } from './workspace-agents.ts';

/**
 * A workspace server turned off for one agent there. Every agent in a workspace reaches every server in it but those
 * turned off here. Written only by a person (`setWorkspaceAgentServerEnabled`). Removing the agent's entry or the
 * server removes the row; a row for a server the workspace no longer has changes nothing.
 */
export const workspaceAgentDisabledServers = pgTable(
  'workspace_agent_disabled_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceAgentId: uuid('workspace_agent_id')
      .notNull()
      .references(() => workspaceAgents.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_workspace_agent_disabled_servers_workspace_agent_id_server_id').on(
      table.workspaceAgentId,
      table.serverId,
    ),
    index('idx_workspace_agent_disabled_servers_server_id').on(table.serverId),
  ],
);

/** A server turned off for an agent, as read. */
export type WorkspaceAgentDisabledServer = typeof workspaceAgentDisabledServers.$inferSelect;
