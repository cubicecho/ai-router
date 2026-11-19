import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { SavedSettings } from '../../core/settings.ts';

/**
 * The router's settings: one row or none, written only by an admin through `updateRouterSettings`. `values` holds
 * only the members an admin set, so the rest follow `ROUTER_DEFAULTS`; with no row, every member does. Read into the
 * snapshot, and served only through hand-written fields.
 */
export const settings = pgTable(
  'settings',
  {
    id: text('id').primaryKey().default('router'),
    values: jsonb('values').$type<SavedSettings>().notNull().default({}),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [check('ck_settings_singleton', sql`${table.id} = 'router'`)],
);

/** The settings row as read. */
export type SettingsRow = typeof settings.$inferSelect;
