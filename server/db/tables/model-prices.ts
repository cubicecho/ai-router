import { sql } from 'drizzle-orm';
import { check, doublePrecision, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { providers } from './providers.ts';

/**
 * What a provider's model costs, as a person entered it: per million tokens in and out, in whatever currency they
 * use. Nothing is fetched. Written only by `setModelPrice`.
 */
export const modelPrices = pgTable(
  'model_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    /** The model's id at the provider, as usage rows name it. */
    model: text('model').notNull(),
    inputPerMillion: doublePrecision('input_per_million').notNull(),
    outputPerMillion: doublePrecision('output_per_million').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Leads with provider_id, so it is that foreign key's index too.
    uniqueIndex('uq_model_prices_provider_id_model').on(table.providerId, table.model),
    check('ck_model_prices_not_negative', sql`${table.inputPerMillion} >= 0 and ${table.outputPerMillion} >= 0`),
  ],
);

/** A model price row as read. */
export type ModelPrice = typeof modelPrices.$inferSelect;
/** A model price row as inserted. */
export type NewModelPrice = typeof modelPrices.$inferInsert;
