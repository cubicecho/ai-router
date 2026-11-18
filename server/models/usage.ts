import { and, isNotNull, lt, sql } from 'drizzle-orm';
import { USAGE_DEFAULTS, type UsageSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_SECOND } from '../core/wire.ts';
import type { DB } from '../db/client.ts';
import { existingIds } from '../db/existing-ids.ts';
import { providers } from '../db/tables/providers.ts';
import { type NewUsageCount, usageCounts } from '../db/tables/usage-counts.ts';
import { workspaces } from '../db/tables/workspaces.ts';
import type { ReportedUsage } from './usage-reader.ts';

/** Characters of an ISO timestamp that are its date, `YYYY-MM-DD`. */
const ISO_DATE_LENGTH = 10;

/** Who a model call counts under: the run's workspace and agent, and where it went. */
export interface ServedBy {
  /** null for a call no workspace made. */
  workspaceId: string | null;
  workspaceName: string | null;
  /** null for a call no agent made. */
  agentId: string | null;
  agentName: string | null;
  providerId: string;
  providerName: string;
  /** The model's id at the provider. */
  model: string;
}

/** Counts model calls, and writes them to the database every few seconds. */
export interface UsageRecorder {
  /**
   * Counts one answered call.
   *
   * @param served - Who it counts under.
   * @param [reported] - The tokens the provider reported; none counts as zero.
   */
  record(served: ServedBy, reported?: ReportedUsage): void;
  /** Writes what has been counted since the last write. */
  flush(): Promise<void>;
  /** Folds days past the detail window into the all-time rows. */
  fold(): Promise<void>;
  /** Starts the timers that flush and fold. */
  start(): void;
  /** Stops the timers and writes what is left. */
  stop(): Promise<void>;
}

/**
 * Reads the UTC day of a moment.
 *
 * @param moment - The time.
 * @returns `YYYY-MM-DD`.
 */
export function utcDay(moment: Date): string {
  return moment.toISOString().slice(0, ISO_DATE_LENGTH);
}

/**
 * Names the row a count adds to.
 *
 * @param row - The row's key columns.
 * @returns One string per row the unique key tells apart.
 */
function rowKey(row: Pick<NewUsageCount, 'day' | 'workspaceName' | 'agentName' | 'providerName' | 'model'>): string {
  return JSON.stringify([
    row.day ?? null,
    row.workspaceName ?? null,
    row.agentName ?? null,
    row.providerName,
    row.model,
  ]);
}

/**
 * Adds counts to their rows, making the rows that don't exist yet.
 *
 * @param db - The database, or a transaction.
 * @param rows - One row per key, with the counts to add.
 */
async function addCounts(db: Pick<DB, 'insert'>, rows: NewUsageCount[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  await db
    .insert(usageCounts)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        usageCounts.day,
        usageCounts.workspaceName,
        usageCounts.agentName,
        usageCounts.providerName,
        usageCounts.model,
      ],
      set: {
        requests: sql`${usageCounts.requests} + excluded.requests`,
        inputTokens: sql`${usageCounts.inputTokens} + excluded.input_tokens`,
        outputTokens: sql`${usageCounts.outputTokens} + excluded.output_tokens`,
        // The latest ids win: a provider deleted and made again under its name is the one counted now.
        workspaceId: sql`coalesce(excluded.workspace_id, ${usageCounts.workspaceId})`,
        agentId: sql`coalesce(excluded.agent_id, ${usageCounts.agentId})`,
        providerId: sql`coalesce(excluded.provider_id, ${usageCounts.providerId})`,
      },
    });
}

/**
 * Builds the usage recorder.
 *
 * @param db - Where counts are written.
 * @param [overrides] - Settings that differ from `USAGE_DEFAULTS`.
 * @param [now] - The clock.
 * @returns The recorder, with its timers not yet started.
 */
export function createUsageRecorder(
  db: DB,
  overrides: Partial<UsageSettings> = {},
  now: () => Date = () => new Date(),
): UsageRecorder {
  const { flushSeconds, detailDays, foldEveryHours } = { ...USAGE_DEFAULTS, ...overrides };
  let pending = new Map<string, NewUsageCount>();
  let timers: NodeJS.Timeout[] = [];

  const flush = async (): Promise<void> => {
    const taken = pending;
    pending = new Map();
    try {
      const rows = [...taken.values()];
      const liveProviders = await existingIds(
        db,
        providers,
        providers.id,
        rows.map((row) => row.providerId),
      );
      const liveWorkspaces = await existingIds(
        db,
        workspaces,
        workspaces.id,
        rows.map((row) => row.workspaceId),
      );
      // A provider or workspace deleted since the call keeps its name here, and loses its id.
      await addCounts(
        db,
        rows.map((row) => ({
          ...row,
          providerId: liveProviders.has(row.providerId ?? '') ? row.providerId : null,
          workspaceId: liveWorkspaces.has(row.workspaceId ?? '') ? row.workspaceId : null,
        })),
      );
    } catch (error) {
      console.error(
        `[usage] could not write ${taken.size} counts, keeping them for the next try: ${errorMessage(error)}`,
      );
      for (const [key, row] of taken) {
        const later = pending.get(key);
        pending.set(key, {
          ...row,
          requests: (row.requests ?? 0) + (later?.requests ?? 0),
          inputTokens: (row.inputTokens ?? 0) + (later?.inputTokens ?? 0),
          outputTokens: (row.outputTokens ?? 0) + (later?.outputTokens ?? 0),
        });
      }
    }
  };

  const fold = async (): Promise<void> => {
    const cutoff = utcDay(new Date(now().getTime() - detailDays * MS_PER_DAY));
    await db.transaction(async (tx) => {
      const isOld = and(isNotNull(usageCounts.day), lt(usageCounts.day, cutoff));
      const old = await tx.delete(usageCounts).where(isOld).returning();
      const totals = new Map<string, NewUsageCount>();
      for (const { id: _id, day: _day, ...row } of old) {
        const key = rowKey({ ...row, day: null });
        const sum = totals.get(key);
        totals.set(key, {
          ...row,
          day: null,
          requests: row.requests + (sum?.requests ?? 0),
          inputTokens: row.inputTokens + (sum?.inputTokens ?? 0),
          outputTokens: row.outputTokens + (sum?.outputTokens ?? 0),
        });
      }
      await addCounts(tx, [...totals.values()]);
    });
  };

  return {
    record(served, reported) {
      const row: NewUsageCount = { ...served, day: utcDay(now()) };
      const key = rowKey(row);
      const counted = pending.get(key);
      pending.set(key, {
        ...row,
        requests: (counted?.requests ?? 0) + 1,
        inputTokens: (counted?.inputTokens ?? 0) + (reported?.inputTokens ?? 0),
        outputTokens: (counted?.outputTokens ?? 0) + (reported?.outputTokens ?? 0),
      });
    },
    flush,
    fold,
    start() {
      const report = (task: string) => (error: unknown) =>
        console.error(`[usage] ${task} failed: ${errorMessage(error)}`);
      timers = [
        setInterval(() => void flush(), flushSeconds * MS_PER_SECOND),
        setInterval(() => void fold().catch(report('folding old days')), foldEveryHours * MS_PER_HOUR),
      ];
      for (const timer of timers) {
        timer.unref();
      }
      void fold().catch(report('folding old days'));
    },
    async stop() {
      for (const timer of timers) {
        clearInterval(timer);
      }
      timers = [];
      await flush();
    },
  };
}
