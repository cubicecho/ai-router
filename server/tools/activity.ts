import { lt } from 'drizzle-orm';
import { ACTIVITY_DEFAULTS, type ActivitySettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { MS_PER_DAY, MS_PER_SECOND } from '../core/wire.ts';
import type { DB } from '../db/client.ts';
import { existingIds } from '../db/existing-ids.ts';
import { activity, type NewActivityRow } from '../db/tables/activity.ts';
import { servers } from '../db/tables/servers.ts';
import { workspaces } from '../db/tables/workspaces.ts';

/** Milliseconds in one hour. */
const MS_PER_HOUR = 3_600_000;

/** One finished tool call, as the router records it. Never its arguments or result. */
export interface ToolCallRecord {
  serverId: string | null;
  serverName: string;
  /** null for a call no workspace made. */
  workspaceId: string | null;
  workspaceName: string | null;
  /** null until phase 6, and for a call no agent made. */
  agentId?: string | null;
  agentName?: string | null;
  runId?: string | null;
  /** The tool's own name at the server. */
  tool: string;
  durationMs: number;
  ok: boolean;
  /** Why it failed. Cut short before it is kept. */
  error?: string | null;
}

/** Records tool calls, writing them every few seconds, and deletes them after the retention. */
export interface ActivityRecorder {
  /**
   * Records one call.
   *
   * @param call - What happened.
   */
  record(call: ToolCallRecord): void;
  /** Writes what has been recorded since the last write. */
  flush(): Promise<void>;
  /** Deletes calls past the retention. */
  prune(): Promise<void>;
  /** Starts the timers that flush and prune. */
  start(): void;
  /** Stops the timers and writes what is left. */
  stop(): Promise<void>;
}

/**
 * Builds the activity recorder.
 *
 * @param db - Where calls are written.
 * @param [overrides] - Settings that differ from `ACTIVITY_DEFAULTS`.
 * @param [now] - The clock.
 * @returns The recorder, with its timers not yet started.
 */
export function createActivityRecorder(
  db: DB,
  overrides: Partial<ActivitySettings> = {},
  now: () => Date = () => new Date(),
): ActivityRecorder {
  const { flushSeconds, retentionDays, pruneEveryHours, maxPending, maxErrorLength } = {
    ...ACTIVITY_DEFAULTS,
    ...overrides,
  };
  let pending: NewActivityRow[] = [];
  let timers: NodeJS.Timeout[] = [];

  /**
   * Holds calls until the next write, oldest first, dropping the oldest past `maxPending`.
   *
   * @param older - Calls from before those already held: a write that failed.
   * @param newer - Calls from after them.
   */
  const keep = (older: NewActivityRow[], newer: NewActivityRow[]): void => {
    pending = [...older, ...pending, ...newer].slice(-maxPending);
  };

  const flush = async (): Promise<void> => {
    const taken = pending;
    pending = [];
    if (taken.length === 0) {
      return;
    }
    try {
      const liveServers = await existingIds(
        db,
        servers,
        servers.id,
        taken.map((row) => row.serverId),
      );
      const liveWorkspaces = await existingIds(
        db,
        workspaces,
        workspaces.id,
        taken.map((row) => row.workspaceId),
      );
      // A server or workspace deleted since the call keeps its name here, and loses its id.
      await db.insert(activity).values(
        taken.map((row) => ({
          ...row,
          serverId: liveServers.has(row.serverId ?? '') ? row.serverId : null,
          workspaceId: liveWorkspaces.has(row.workspaceId ?? '') ? row.workspaceId : null,
        })),
      );
    } catch (error) {
      console.error(
        `[activity] could not write ${taken.length} calls, keeping them for the next try: ${errorMessage(error)}`,
      );
      keep(taken, []);
    }
  };

  const prune = async (): Promise<void> => {
    await db.delete(activity).where(lt(activity.at, new Date(now().getTime() - retentionDays * MS_PER_DAY)));
  };

  return {
    record(call) {
      keep([], [{ ...call, error: call.error?.slice(0, maxErrorLength) ?? null, at: now() }]);
    },
    flush,
    prune,
    start() {
      const report = (error: unknown) => console.error(`[activity] pruning old calls failed: ${errorMessage(error)}`);
      timers = [
        setInterval(() => void flush(), flushSeconds * MS_PER_SECOND),
        setInterval(() => void prune().catch(report), pruneEveryHours * MS_PER_HOUR),
      ];
      for (const timer of timers) {
        timer.unref();
      }
      void prune().catch(report);
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
