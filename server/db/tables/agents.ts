import { type AnyPgColumn, boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agentRevisions } from './agent-revisions.ts';
import { DEFAULT_POLICY_ID, overridePolicies } from './override-policies.ts';

/**
 * An agent: a model, a prompt and tools defined once, for any app to run. Its content is in its
 * revisions; the one it runs is `live_revision_id`.
 */
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Its router name: the document's `id`, and the model an app picks on the agents endpoint. */
    name: text('name').notNull(),
    /** What the layers above it may change. The seeded default until policies can be chosen. */
    overridePolicyId: uuid('override_policy_id')
      .notNull()
      .default(DEFAULT_POLICY_ID)
      .references(() => overridePolicies.id, { onDelete: 'restrict' }),
    /** The revision it runs and serves. Null for an agent that cannot run. Typed by hand: the two tables name each other. */
    liveRevisionId: uuid('live_revision_id').references((): AnyPgColumn => agentRevisions.id, {
      onDelete: 'set null',
    }),
    /** A user's choice to let drafts go live without review. Phase 9; never in the document. */
    autoPromote: boolean('auto_promote').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_agents_name').on(table.name),
    index('idx_agents_override_policy_id').on(table.overridePolicyId),
  ],
);

/** An agent row as read. */
export type AgentRow = typeof agents.$inferSelect;
