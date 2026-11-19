import { and, desc, eq, isNotNull, type SQL, sql } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { RunStatus, runs } from '../db/tables/runs.ts';

/** One session: the runs of one workspace that the app sent under the same key. */
export interface RunSession {
  key: string;
  workspaceId: string | null;
  /** The workspace's slug when its latest run started. */
  workspaceName: string;
  /** The agents that ran in it, by name, A to Z. */
  agentNames: string[];
  runCount: number;
  /** Its runs that are running or waiting. */
  openRunCount: number;
  /** When its first run started. */
  startedAt: Date;
  /** When its latest run started. */
  lastStartedAt: Date;
  inputTokens: number;
  outputTokens: number;
}

/** Which sessions to list, and which page. */
export interface RunSessionFilters {
  workspaceId?: string | null | undefined;
  /** Only sessions this agent ran in. */
  agentName?: string | null | undefined;
  limit: number;
  offset: number;
}

/** A page of sessions, and how many match in all. */
export interface RunSessionPage {
  sessions: RunSession[];
  count: number;
}

/** The statuses of a run that is still going. */
const OPEN = sql.join(
  [RunStatus.Running, RunStatus.Waiting].map((status) => sql`${status}`),
  sql`, `,
);

/**
 * Lists sessions, the latest first.
 *
 * @param db - The database.
 * @param filters - The workspace and agent, and the page.
 * @returns The page, and the count.
 */
export async function listRunSessions(
  db: DB,
  { workspaceId, agentName, limit, offset }: RunSessionFilters,
): Promise<RunSessionPage> {
  const conditions: SQL[] = [isNotNull(runs.sessionKey)];
  if (workspaceId !== null && workspaceId !== undefined) {
    conditions.push(eq(runs.workspaceId, workspaceId));
  }
  const hasAgent = agentName !== null && agentName !== undefined;
  const lastStartedAt = sql`max(${runs.startedAt})`;
  const grouped = db
    .select({
      key: sql<string>`${runs.sessionKey}`.as('key'),
      workspaceId: sql<string | null>`${runs.workspaceId}`.as('workspace_id'),
      workspaceName: sql<string>`(array_agg(${runs.workspaceName} order by ${runs.startedAt} desc))[1]`.as(
        'workspace_name',
      ),
      agentNames: sql<string[]>`array_agg(distinct ${runs.agentName} order by ${runs.agentName})`.as('agent_names'),
      runCount: sql<number>`count(*)::int`.as('run_count'),
      openRunCount: sql<number>`(count(*) filter (where ${runs.status} in (${OPEN})))::int`.as('open_run_count'),
      startedAt: sql`min(${runs.startedAt})`.mapWith(runs.startedAt).as('started_at'),
      lastStartedAt: lastStartedAt.mapWith(runs.startedAt).as('last_started_at'),
      inputTokens: sql`sum(${runs.inputTokens})`.mapWith(Number).as('input_tokens'),
      outputTokens: sql`sum(${runs.outputTokens})`.mapWith(Number).as('output_tokens'),
    })
    .from(runs)
    .where(and(...conditions))
    .groupBy(runs.workspaceId, runs.sessionKey)
    .having(hasAgent ? sql`bool_or(${runs.agentName} = ${agentName})` : undefined);
  const page = grouped.as('sessions');
  const [sessions, [total]] = await Promise.all([
    db.select().from(page).orderBy(desc(page.lastStartedAt), page.key).limit(limit).offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(page),
  ]);
  return { sessions, count: total?.count ?? 0 };
}
