import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { servers } from './servers.ts';
import { workspaceAgents } from './workspace-agents.ts';

/**
 * A tool of a workspace server turned off for one agent there, by the tool's own name on its server (never the name a
 * run gives it). Every tool of a server that is on is reached but those turned off here, so a tool the server adds
 * later is on. Written only by a person (`setWorkspaceAgentToolEnabled`). A row for a tool the server no longer offers
 * changes nothing.
 */
export const workspaceAgentDisabledTools = pgTable(
  'workspace_agent_disabled_tools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceAgentId: uuid('workspace_agent_id')
      .notNull()
      .references(() => workspaceAgents.id, { onDelete: 'cascade' }),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    /** The tool's name on its server, before any `<server>__`. */
    tool: text('tool').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_workspace_agent_disabled_tools_workspace_agent_id_server_id_tool').on(
      table.workspaceAgentId,
      table.serverId,
      table.tool,
    ),
    index('idx_workspace_agent_disabled_tools_server_id').on(table.serverId),
  ],
);

/** A tool turned off for an agent, as read. */
export type WorkspaceAgentDisabledTool = typeof workspaceAgentDisabledTools.$inferSelect;
