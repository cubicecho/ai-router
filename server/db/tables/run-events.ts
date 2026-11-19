import type { RunEvent } from '@cubicecho/agent-core';
import { integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { runs } from './runs.ts';

/**
 * One thing a run did, in order: agent-core's `RunEvent`, with each stretch of streamed `thinking` or `output` joined
 * into one row by agent-core's `fold`. Written by the router only, and deleted with its run.
 */
export const runEvents = pgTable(
  'run_events',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** The event's own `seq`, or a joined stretch's last one: increasing, with gaps where stretches were joined. */
    seq: integer('seq').notNull(),
    /** The event's `kind`, beside it for reading a run's tool calls without the whole event. */
    kind: text('kind').notNull(),
    /** The event as it was sent, or the stretch as `fold` joined it. */
    event: jsonb('event').$type<RunEvent>().notNull(),
    /**
     * For a joined stretch, where each of its events' text ends in the row's text, one entry per event, so a reader
     * that has part of the stretch gets only the rest. Null for a row that holds one event.
     */
    textEnds: integer('text_ends').array(),
  },
  (table) => [primaryKey({ name: 'pk_run_events', columns: [table.runId, table.seq] })],
);

/** A run event row as read. */
export type RunEventRow = typeof runEvents.$inferSelect;
/** A run event row as inserted. */
export type NewRunEventRow = typeof runEvents.$inferInsert;
