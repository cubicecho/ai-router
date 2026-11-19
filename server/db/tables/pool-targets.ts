import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { pools } from './pools.ts';
import { providers } from './providers.ts';

/** The weight that gives a target an equal share of its pool's calls. What a target has unless it says otherwise. */
export const EQUAL_WEIGHT = 1;

/** One place a pool can send a call: a provider, and the model's id there. Written whole by `setPoolTargets`. */
export const poolTargets = pgTable(
  'pool_targets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    poolId: uuid('pool_id')
      .notNull()
      .references(() => pools.id, { onDelete: 'cascade' }),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    /** The model's id at the provider. May itself hold `/`. */
    model: text('model').notNull(),
    /** The target's place in the pool, from 0. Round-robin and ties follow it. */
    position: integer('position').notNull(),
    /** Its share of the pool's calls: a target of weight 2 takes twice the calls of one of weight 1. */
    weight: integer('weight').notNull().default(EQUAL_WEIGHT),
  },
  (table) => [
    uniqueIndex('uq_pool_targets_pool_id_provider_id_model').on(table.poolId, table.providerId, table.model),
    index('idx_pool_targets_provider_id').on(table.providerId),
    check('ck_pool_targets_weight', sql`${table.weight} >= 1`),
  ],
);

/** A pool target row as read. */
export type PoolTarget = typeof poolTargets.$inferSelect;
/** A pool target row as inserted. */
export type NewPoolTarget = typeof poolTargets.$inferInsert;
