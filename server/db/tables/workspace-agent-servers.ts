import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { servers } from './servers.ts';
import { workspaceAgents } from './workspace-agents.ts';

/**
 * A server an agent may use in one workspace: its runs there reach exactly the servers granted here, and none
 * without a grant. Written only by `setWorkspaceAgentServers`, from a person. Removing the agent's entry or the
 * server removes the grant.
 */
export const workspaceAgentServers = pgTable(
  'workspace_agent_servers',
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
    uniqueIndex('uq_workspace_agent_servers_workspace_agent_id_server_id').on(table.workspaceAgentId, table.serverId),
    index('idx_workspace_agent_servers_server_id').on(table.serverId),
  ],
);

/** A grant as read. */
export type WorkspaceAgentServer = typeof workspaceAgentServers.$inferSelect;
