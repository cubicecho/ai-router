import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agents } from './agents.ts';
import { users } from './users.ts';
import { workspaces } from './workspaces.ts';

/**
 * One saved version of an agent. Every save makes one, and every earlier one is kept, so promoting
 * an older one is a rollback.
 */
export const agentRevisions = pgTable(
  'agent_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    /** 1 for the agent's first save, and one more for each after. */
    number: integer('number').notNull(),
    /**
     * The `cubicecho.agent/1` document, stored as received, unknown keys included, so a later 1.x
     * survives. A bundled server's env and headers are the one thing taken out.
     */
    document: jsonb('document').$type<Record<string, unknown>>().notNull(),
    /** What `parseSpec` and the router said about it when it was saved. Never a reason it was refused. */
    warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
    /** What changed, in the saver's words. */
    message: text('message').notNull().default(''),
    /** The user who saved it. Null for a run's save, and once that user is deleted. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** The workspace whose agent run saved it through the admin server. Null for a person's save. */
    savedByWorkspaceId: uuid('saved_by_workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    /** The agent whose run saved it, with `savedByWorkspaceId`. That agent may discard it while it is a draft. */
    savedByAgentId: uuid('saved_by_agent_id').references((): AnyPgColumn => agents.id, { onDelete: 'set null' }),
    /** The revision the save started from, when it said. Null for an agent's first. */
    basedOnId: uuid('based_on_id').references((): AnyPgColumn => agentRevisions.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** When it last went live. Null for one never promoted; set and not live is retired. */
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('uq_agent_revisions_agent_id_number').on(table.agentId, table.number),
    index('idx_agent_revisions_created_by').on(table.createdBy),
    index('idx_agent_revisions_saved_by_workspace_id').on(table.savedByWorkspaceId),
    index('idx_agent_revisions_saved_by_agent_id').on(table.savedByAgentId),
    index('idx_agent_revisions_based_on_id').on(table.basedOnId),
  ],
);

/** A revision row as read. */
export type AgentRevision = typeof agentRevisions.$inferSelect;
