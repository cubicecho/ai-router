import type { RunEvent } from '@cubicecho/agent-core';
import { integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { runs } from './runs.ts';

/**
 * One thing a run did, in order: agent-core's `RunEvent`, stored as it was sent. Written by the router only, and
 * deleted with its run.
 */
export const runEvents = pgTable(
  'run_events',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** Its place in the run, from 1, with no gaps: the event's own `seq`. */
    seq: integer('seq').notNull(),
    /** The event's `kind`, beside it for reading a run's tool calls without the whole event. */
    kind: text('kind').notNull(),
    /** The event, unchanged. */
    event: jsonb('event').$type<RunEvent>().notNull(),
  },
  (table) => [primaryKey({ name: 'pk_run_events', columns: [table.runId, table.seq] })],
);

/** A run event row as read. */
export type RunEventRow = typeof runEvents.$inferSelect;
