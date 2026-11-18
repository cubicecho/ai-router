import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * What one app sees: the agents, models and servers it may use. Its keys say which app is calling.
 * A workspace owns nothing: what it lists lives in the router and is shared.
 */
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** A short name for people and for imports, such as `min-agent`. Never part of a URL. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex('uq_workspaces_slug').on(table.slug)],
);

/** A workspace row as read. */
export type Workspace = typeof workspaces.$inferSelect;
/** A workspace row as inserted. */
export type NewWorkspace = typeof workspaces.$inferInsert;
