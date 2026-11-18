import { bigint, date, index, integer, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { providers } from './providers.ts';
import { workspaces } from './workspaces.ts';

/**
 * Requests and tokens, per UTC day, workspace, agent, provider and model. A row is keyed by names, so
 * it outlives what it names: deleting a provider or workspace only clears its id here.
 */
export const usageCounts = pgTable(
  'usage_counts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The UTC day, `YYYY-MM-DD`. Null for the all-time row that days past the detail window fold into. */
    day: date('day', { mode: 'string' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    /** Null for calls no workspace made, such as a user trying a model in the UI. */
    workspaceName: text('workspace_name'),
    /** The agent whose run made the calls. Filled from phase 6; its foreign key comes with the agents table. */
    agentId: uuid('agent_id'),
    agentName: text('agent_name'),
    providerId: uuid('provider_id').references(() => providers.id, { onDelete: 'set null' }),
    providerName: text('provider_name').notNull(),
    /** The model's id at the provider. */
    model: text('model').notNull(),
    requests: integer('requests').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  },
  (table) => [
    unique('uq_usage_counts_key')
      .on(table.day, table.workspaceName, table.agentName, table.providerName, table.model)
      .nullsNotDistinct(),
    index('idx_usage_counts_workspace_id').on(table.workspaceId),
    index('idx_usage_counts_provider_id').on(table.providerId),
    index('idx_usage_counts_day').on(table.day),
  ],
);

/** A usage row as read. */
export type UsageCount = typeof usageCounts.$inferSelect;
/** A usage row as inserted. */
export type NewUsageCount = typeof usageCounts.$inferInsert;
