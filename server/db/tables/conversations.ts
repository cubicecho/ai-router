import type { AgentLoopOptions } from '@cubicecho/agent-core';
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agents } from './agents.ts';
import { workspaces } from './workspaces.ts';

/**
 * One chat an app keeps going with an agent, named by the app's `X-Conversation-Id`, so the app sends only new
 * messages. Written by the router only, and deleted once it has been idle past its time.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The app's own name for it, from `X-Conversation-Id`: one per workspace. */
    key: text('key').notNull(),
    /** The agent it is with. Another agent can't join it. */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    agentName: text('agent_name').notNull(),
    /** The app's system messages of its latest run, which a request that sends none carries on with. */
    systemText: text('system_text'),
    /** The transcript so far, without the system prompt: every run's messages, tool calls and results included. */
    messages: jsonb('messages').$type<AgentLoopOptions['messages']>().notNull().default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** When it is deleted if nothing uses it before then. Moved on by every request and every run's end. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_conversations_workspace_id_key').on(table.workspaceId, table.key),
    index('idx_conversations_expires_at').on(table.expiresAt),
    index('idx_conversations_agent_id').on(table.agentId),
  ],
);

/** A conversation row as read. */
export type ConversationRow = typeof conversations.$inferSelect;
