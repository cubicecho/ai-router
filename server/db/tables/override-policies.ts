import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { OverridePolicyRules } from '../../agents/policy.ts';

/** The seeded policy's id. A new agent uses it, and it is never deleted. */
export const DEFAULT_POLICY_ID = '00000000-0000-4000-8000-000000000001';

/**
 * What the layers above an agent may change. Seeded with the default, which a new agent uses; an admin adds more,
 * and a user chooses one per agent. Never in the agent's document, so the document stays portable.
 */
export const overridePolicies = pgTable(
  'override_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    rules: jsonb('rules').$type<OverridePolicyRules>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex('uq_override_policies_name').on(table.name)],
);

/** A policy row as read. */
export type OverridePolicy = typeof overridePolicies.$inferSelect;
