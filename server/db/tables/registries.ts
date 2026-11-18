import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** A catalogue of MCP servers users can browse and install from, such as the official MCP registry. */
export const registries = pgTable(
  'registries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** A short name, such as `official`. A server installed from it names it in its source. */
    name: text('name').notNull(),
    /** The base URL of a service that speaks the MCP registry API. */
    url: text('url').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex('uq_registries_name').on(table.name)],
);

/** A registry row as read. */
export type RegistryRow = typeof registries.$inferSelect;
