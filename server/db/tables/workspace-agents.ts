import { index, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents.ts';
import { workspaces } from './workspaces.ts';

/** An agent a workspace's apps may run. A workspace owns nothing: removing the entry changes nothing else. */
export const workspaceAgents = pgTable(
  'workspace_agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_workspace_agents_workspace_id_agent_id').on(table.workspaceId, table.agentId),
    index('idx_workspace_agents_agent_id').on(table.agentId),
  ],
);

/** A workspace's agent row as read. */
export type WorkspaceAgent = typeof workspaceAgents.$inferSelect;
