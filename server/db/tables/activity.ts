import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents.ts';
import { servers } from './servers.ts';
import { workspaces } from './workspaces.ts';

/**
 * One tool call made through the router, kept for a while. Keyed by names as well as ids, so a row
 * outlives the server or workspace it names. Written by the router only.
 */
export const activity = pgTable(
  'activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    serverId: uuid('server_id').references(() => servers.id, { onDelete: 'set null' }),
    serverName: text('server_name').notNull(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    /** Null for a call no workspace made, such as a user trying a tool in the UI. */
    workspaceName: text('workspace_name'),
    /** The agent whose run made the call. Filled from phase 6. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    agentName: text('agent_name'),
    /** The run, from phase 6. */
    runId: uuid('run_id'),
    /** The tool's own name at the server. */
    tool: text('tool').notNull(),
    durationMs: integer('duration_ms').notNull(),
    ok: boolean('ok').notNull(),
    /** Why it failed, cut short. Never the call's arguments or result. */
    error: text('error'),
  },
  (table) => [
    index('idx_activity_at').on(table.at),
    index('idx_activity_server_id').on(table.serverId),
    index('idx_activity_workspace_id').on(table.workspaceId),
  ],
);

/** An activity row as read. */
export type ActivityRow = typeof activity.$inferSelect;
/** An activity row as inserted. */
export type NewActivityRow = typeof activity.$inferInsert;
