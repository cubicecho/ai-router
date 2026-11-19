import { and, desc, eq, isNotNull, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { RUN_DEFAULTS } from '../core/defaults.ts';
import type { DB } from '../db/client.ts';
import { RunStatus, runs } from '../db/tables/runs.ts';

/** One session: the runs of one workspace that the app sent under the same key. */
export interface RunSession {
  key: string;
  /** Its first user message, on one line and cut short: what it was about. Null when no run had one. */
  title: string | null;
  workspaceId: string | null;
  /** The workspace's slug when its latest run started. */
  workspaceName: string;
  /** The agents that ran in it, by name, A to Z. */
  agentNames: string[];
  runCount: number;
  /** Its runs that are running or waiting. */
  openRunCount: number;
  /** Its runs that failed or expired. */
  failedRunCount: number;
  cancelledRunCount: number;
  /** How its latest run is, or ended. */
  lastStatus: string;
  /** The error of its latest run that failed or expired. Null when none did. */
  lastError: string | null;
  /** When its first run started. */
  startedAt: Date;
  /** When its latest run started. */
  lastStartedAt: Date;
  /** When its last run to end ended. Null while one is still going, or when none has ended. */
  lastFinishedAt: Date | null;
  /** The time its runs took, added up, a run still going counted to now. Waits for the app count. */
  runMs: number;
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

/**
 * Lists statuses for an `in (…)`.
 *
 * @param statuses - The statuses.
 * @returns Them, as parameters.
 */
function statusList(...statuses: RunStatus[]): SQL {
  return sql.join(
    statuses.map((status) => sql`${status}`),
    sql`, `,
  );
}

/** The statuses of a run that is still going. */
const OPEN = statusList(RunStatus.Running, RunStatus.Waiting);
/** The statuses of a run that went wrong. A cancel is someone's choice, so it isn't one. */
const FAILED = statusList(RunStatus.Failed, RunStatus.Expired);
/** How much of a first message is read for a title. A title needs little, and a prompt may be long. */
const TITLE_READ_LENGTH = 2_000;
/** What a cut title ends with. */
const ELLIPSIS = '…';

/**
 * Makes a title of a session's first message.
 *
 * @param text - The message, its whitespace already on one line.
 * @param length - The most characters the title has.
 * @returns It, cut at the length with an ellipsis; null when it is empty.
 */
export function titleOf(text: string | null, length: number = RUN_DEFAULTS.sessionTitleLength): string | null {
  const line = text?.trim() ?? '';
  if (line === '') {
    return null;
  }
  return line.length > length ? `${line.slice(0, length - ELLIPSIS.length).trimEnd()}${ELLIPSIS}` : line;
}

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
      failedRunCount: sql<number>`(count(*) filter (where ${runs.status} in (${FAILED})))::int`.as('failed_run_count'),
      cancelledRunCount: sql<number>`(count(*) filter (where ${runs.status} = ${RunStatus.Cancelled}))::int`.as(
        'cancelled_run_count',
      ),
      lastStatus: sql<string>`(array_agg(${runs.status} order by ${runs.startedAt} desc))[1]`.as('last_status'),
      lastError: sql<string | null>`(array_agg(${runs.error} order by ${runs.startedAt} desc) filter (
        where ${runs.status} in (${FAILED}) and ${runs.error} is not null))[1]`.as('last_error'),
      startedAt: sql`min(${runs.startedAt})`.mapWith(runs.startedAt).as('started_at'),
      lastStartedAt: lastStartedAt.mapWith(runs.startedAt).as('last_started_at'),
      lastFinishedAt: sql`case when bool_or(${runs.finishedAt} is null) then null else max(${runs.finishedAt}) end`
        .mapWith(runs.finishedAt)
        .as('last_finished_at'),
      runMs: sql`sum(extract(epoch from coalesce(${runs.finishedAt}, now()) - ${runs.startedAt}) * 1000)`
        .mapWith(Number)
        .as('run_ms'),
      inputTokens: sql`sum(${runs.inputTokens})`.mapWith(Number).as('input_tokens'),
      outputTokens: sql`sum(${runs.outputTokens})`.mapWith(Number).as('output_tokens'),
    })
    .from(runs)
    .where(and(...conditions))
    .groupBy(runs.workspaceId, runs.sessionKey)
    .having(hasAgent ? sql`bool_or(${runs.agentName} = ${agentName})` : undefined);
  const page = grouped.as('sessions');
  // Read for the page's sessions only: the first user message of the first run that has one.
  const first = alias(runs, 'first_run');
  const firstMessage = sql<string | null>`(
    select btrim(regexp_replace(left(message.value ->> 'content', ${TITLE_READ_LENGTH}), '[[:space:]]+', ' ', 'g'))
    from ${runs} as ${first}, jsonb_array_elements(${first.input}) with ordinality as message(value, n)
    where ${first.sessionKey} = ${page.key}
      and ${first.workspaceId} is not distinct from ${page.workspaceId}
      and message.value ->> 'role' = 'user'
      and btrim(message.value ->> 'content') <> ''
    order by ${first.startedAt}, message.n
    limit 1
  )`;
  const { key, ...rest } = page._.selectedFields;
  const [rows, [total]] = await Promise.all([
    db
      .select({ key, ...rest, firstMessage })
      .from(page)
      .orderBy(desc(page.lastStartedAt), page.key)
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(page),
  ]);
  const sessions = rows.map(({ firstMessage: text, ...session }) => ({ ...session, title: titleOf(text) }));
  return { sessions, count: total?.count ?? 0 };
}
