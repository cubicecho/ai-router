import { sql } from 'drizzle-orm';
import { boolean, check, pgTable, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** How a pool picks a target when affinity doesn't decide. */
export const PoolStrategy = { LeastBusy: 'least-busy', RoundRobin: 'round-robin', Random: 'random' } as const;
export type PoolStrategy = (typeof PoolStrategy)[keyof typeof PoolStrategy];

/** Keeps one conversation on one target, so its prompt cache is reused. */
export const AFFINITY_STICKY = 'sticky' as const;
/** Every call is placed on its own. */
export const AFFINITY_NONE = 'none' as const;
/** Whether a pool keeps a conversation on one target. */
export type PoolAffinity = typeof AFFINITY_STICKY | typeof AFFINITY_NONE;

/** One model name served by several targets, with the router choosing one for each call. */
export const pools = pgTable(
  'pools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** What an agent names as its model. Never holds `/`, so it can't be read as `<provider>/<model>`. */
    name: text('name').notNull(),
    displayName: text('display_name'),
    description: text('description').notNull().default(''),
    enabled: boolean('enabled').notNull().default(true),
    strategy: text('strategy', { enum: [PoolStrategy.LeastBusy, PoolStrategy.RoundRobin, PoolStrategy.Random] })
      .notNull()
      .default(PoolStrategy.LeastBusy),
    affinity: text('affinity', { enum: [AFFINITY_STICKY, AFFINITY_NONE] })
      .notNull()
      .default(AFFINITY_STICKY),
    /** Bounded load: a sticky call skips a target holding more than this times the average. Null is off. */
    maxLoadFactor: real('max_load_factor'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_pools_name').on(table.name),
    check('ck_pools_strategy', sql`${table.strategy} in ('least-busy', 'round-robin', 'random')`),
    check('ck_pools_affinity', sql`${table.affinity} in ('sticky', 'none')`),
    check('ck_pools_max_load_factor', sql`${table.maxLoadFactor} is null or ${table.maxLoadFactor} >= 1`),
  ],
);

/** A pool row as read. */
export type Pool = typeof pools.$inferSelect;
/** A pool row as inserted. */
export type NewPool = typeof pools.$inferInsert;
