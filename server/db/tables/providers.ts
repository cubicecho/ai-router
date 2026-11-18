import { sql } from 'drizzle-orm';
import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** A model server the router's agents call: OpenAI, Ollama, llama.cpp, anything OpenAI-compatible. */
export const providers = pgTable(
  'providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The router name agents put before a model's id: `<name>/<model>`. */
    name: text('name').notNull(),
    displayName: text('display_name'),
    description: text('description').notNull().default(''),
    /** A disabled provider takes no calls, and its pools' targets on it are passed over. */
    enabled: boolean('enabled').notNull().default(true),
    /** The OpenAI base URL, such as `http://ollama:11434/v1`. */
    baseUrl: text('base_url').notNull(),
    /** Sent as `Authorization: Bearer`. A secret: never served, set by `setProviderApiKey`. */
    apiKey: text('api_key'),
    /** Whether a key is set: what the API serves in place of the key. Kept by Postgres, never written. */
    apiKeySet: boolean('api_key_set').notNull().generatedAlwaysAs(sql`api_key is not null and api_key <> ''`),
    /** Sent with every call, after the key, so one here wins. Not secret, for now. */
    headers: jsonb('headers').$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex('uq_providers_name').on(table.name)],
);

/** A provider row as read. */
export type Provider = typeof providers.$inferSelect;
/** A provider row as inserted. */
export type NewProvider = typeof providers.$inferInsert;
