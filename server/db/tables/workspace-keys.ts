import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.ts';
import { workspaces } from './workspaces.ts';

/**
 * A secret an app sends with every request, and the only kind of key. Only its hash is kept: the key
 * itself exists in the answer to the mutation that made it. Deleting the row revokes it.
 */
export const workspaceKeys = pgTable(
  'workspace_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** What the app is, for people: `phone`, `desktop`. */
    name: text('name').notNull(),
    /** The key's prefix and first characters, in the clear, so a list can tell keys apart. */
    start: text('start').notNull(),
    /** SHA-256 of the whole key, in hex. A key is long and random, so a fast hash is enough. */
    hash: text('hash').notNull(),
    /** Who made it. Null once that user is deleted: the key stays the workspace's. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** null for a key that never expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_workspace_keys_hash').on(table.hash),
    index('idx_workspace_keys_workspace_id').on(table.workspaceId),
    index('idx_workspace_keys_created_by').on(table.createdBy),
  ],
);

/** A workspace key row as read. */
export type WorkspaceKey = typeof workspaceKeys.$inferSelect;
/** A workspace key row as inserted. */
export type NewWorkspaceKey = typeof workspaceKeys.$inferInsert;
