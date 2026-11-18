import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentRevisions } from './agent-revisions.ts';
import { agents } from './agents.ts';
import { workspaces } from './workspaces.ts';

/** Where a run is in its life. Phase 7 adds waiting and expired. */
export const RunStatus = {
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

/** What a finished run answered, kept so a repeated `Idempotency-Key` gets the same answer. */
export interface RunAnswer {
  /** The text the agent wrote, every turn's joined by a blank line. */
  content: string;
  /** Why its last turn ended, in OpenAI's words: `stop` or `length`. */
  finishReason: string;
}

/**
 * One agent answering one request on the agents endpoint. Keyed by names as well as ids, so a run outlives the
 * workspace and agent it names. Written by the router only, and unchanged once it ends but for retention.
 */
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    /** The workspace's slug when the run started, as usage and activity name it. */
    workspaceName: text('workspace_name').notNull(),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    agentName: text('agent_name').notNull(),
    /** The revision it ran. A revision promoted mid-run applies to the next run. */
    revisionId: uuid('revision_id').references(() => agentRevisions.id, { onDelete: 'set null' }),
    status: text('status', { enum: [RunStatus.Running, RunStatus.Completed, RunStatus.Failed, RunStatus.Cancelled] })
      .notNull()
      .default(RunStatus.Running),
    /** The request's `user`, for the app's own reference. */
    user: text('user'),
    /** Whether the request that started it asked for a stream. */
    stream: boolean('stream').notNull(),
    /** The request's `Idempotency-Key`. Cleared once the idempotency window has passed, so the key can start a run again. */
    idempotencyKey: text('idempotency_key'),
    /** The SHA-256 of the request body, less `stream` and `stream_options`, that the key was first sent with. */
    requestHash: text('request_hash'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null while it runs. */
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** Prompt tokens over every model call of the main loop, as the provider reported them. */
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    /** Why it failed or was cancelled. */
    error: text('error'),
    /** What it answered. Null until it completes. */
    answer: jsonb('answer').$type<RunAnswer>(),
  },
  (table) => [
    // Nulls are distinct, so runs sent without a key never clash.
    uniqueIndex('uq_runs_workspace_id_idempotency_key').on(table.workspaceId, table.idempotencyKey),
    index('idx_runs_started_at').on(table.startedAt),
    index('idx_runs_agent_id').on(table.agentId),
    index('idx_runs_revision_id').on(table.revisionId),
    index('idx_runs_status').on(table.status),
    check('ck_runs_status', sql`${table.status} in ('running', 'completed', 'failed', 'cancelled')`),
  ],
);

/** A run row as read. */
export type RunRow = typeof runs.$inferSelect;
/** A run row as inserted. */
export type NewRunRow = typeof runs.$inferInsert;
