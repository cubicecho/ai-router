import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { servers } from './servers.ts';
import { workspaces } from './workspaces.ts';

/** What a secret is for. */
export const SecretKind = {
  /** An env var a server's program gets. */
  Env: 'env',
  /** A header sent to a server reached over HTTP. */
  Header: 'header',
} as const;
export type SecretKind = (typeof SecretKind)[keyof typeof SecretKind];

/**
 * A server's secret env values and header values: the server's own, or a workspace's override of one.
 * The API serves only their names. Written by `setServerSecret`.
 */
export const serverSecrets = pgTable(
  'server_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    /** Null for the server's own value; a workspace's override otherwise. */
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: [SecretKind.Env, SecretKind.Header] }).notNull(),
    /** The env var's or header's name. */
    name: text('name').notNull(),
    /** A secret: never served. */
    value: text('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('uq_server_secrets_key').on(table.serverId, table.workspaceId, table.kind, table.name).nullsNotDistinct(),
    index('idx_server_secrets_workspace_id').on(table.workspaceId),
  ],
);

/** A secret row as read. */
export type ServerSecret = typeof serverSecrets.$inferSelect;
