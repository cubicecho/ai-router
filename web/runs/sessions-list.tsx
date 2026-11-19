import { Link } from '@tanstack/react-router';
import type { RunFilters, RunSessionsQuery } from '@/__generated__/graphql';
import { CollapsibleRow } from '@/components/collapsible-row';
import { List } from '@/components/list';
import { LoadError, RowSkeleton } from '@/components/load-state';
import { Button } from '@/components/ui/button';
import { ArrowRight } from '@/components/ui/icons';
import { useOpenRows } from '@/lib/use-open-rows';
import { RunStatusBadge } from './run-status-badge';
import { RunsList } from './runs-list';
import { formatCount, formatDuration, formatTokens, isOpen, RunStatus, startedOf } from './shapes';
import { useNow, useRuns } from './use-runs';

/** One session, as the Sessions tab reads it. */
export type RunSessionRow = RunSessionsQuery['runSessions']['sessions'][number];

/** How many of a session's runs its row shows when opened. More are a link away. */
const SESSION_RUNS = 25;

/**
 * Builds the filter that finds a session's runs.
 *
 * @param session - The session.
 * @returns Its key, in its workspace, or in the workspace's old slug once the workspace is deleted.
 */
function sessionRunsWhere(session: RunSessionRow): RunFilters {
  const inWorkspace =
    session.workspaceId === null
      ? { workspaceName: { eq: session.workspaceName } }
      : { workspaceId: { eq: session.workspaceId } };
  return { sessionKey: { eq: session.key }, ...inWorkspace };
}

/**
 * Says how long a session has gone on: from its first run's start to its last run's end.
 *
 * @param session - The session.
 * @returns Such as "Over 3 min 4 s", or that it is still going.
 */
function spanOf(session: RunSessionRow): string {
  if (session.lastFinishedAt === null || session.lastFinishedAt === undefined) {
    return 'Still going';
  }
  const ms = Math.max(0, Date.parse(session.lastFinishedAt) - Date.parse(session.startedAt));
  return `Over ${formatDuration(ms)}`;
}

/** A session's runs, newest first, read when its row opens. */
function SessionRuns({ session }: { session: RunSessionRow }) {
  const runs = useRuns({ where: sessionRunsWhere(session), limit: SESSION_RUNS, offset: 0 });
  const rows = runs.data?.runs ?? [];
  const now = useNow(rows.some((run) => isOpen(run.status)));
  if (runs.isError) {
    return <LoadError error={runs.error} onRetry={runs.refetch} what="its runs" compact />;
  }
  if (runs.isPending) {
    return <RowSkeleton rows={2} />;
  }
  const isCut = session.runCount > rows.length;
  return (
    <div className="grid gap-3">
      <RunsList rows={rows} now={now} label={`Runs of ${session.key}`} hideWorkspace />
      {isCut ? (
        <Button
          className="justify-self-start"
          variant="outline"
          size="sm"
          iconSlot={<ArrowRight />}
          linkSlot={
            <Link to="/agent-runs" search={{ session: session.key, workspace: session.workspaceId ?? undefined }} />
          }
          content={`All ${formatCount(session.runCount)} runs`}
        />
      ) : null}
    </div>
  );
}

/** What the list is given. */
export interface SessionsListProps {
  /** The sessions, the latest first. */
  sessions: readonly RunSessionRow[];
}

/**
 * Sessions, one closed row each: its title or key, where it came from, its agents, when and for how long, how many runs
 * and how many failed (the latest error on hover) or were cancelled, the time and tokens they took, and how the latest
 * is. A row opens onto its runs.
 */
export function SessionsList({ sessions }: SessionsListProps) {
  const rows = useOpenRows<string>();
  return (
    <List
      label="Sessions"
      contentSlot={sessions.map((session) => {
        const id = `${session.workspaceId ?? session.workspaceName}/${session.key}`;
        const runCount = `${formatCount(session.runCount)} ${session.runCount === 1 ? 'run' : 'runs'}`;
        const key = <span className="font-mono">{session.key}</span>;
        return (
          <CollapsibleRow
            key={id}
            open={rows.isOpen(id)}
            onOpenChange={(next) => rows.setOpen(id, next)}
            title={session.title ?? key}
            description={
              <span className="grid gap-0.5 text-foreground/60 text-sm">
                <span>
                  {session.title === null || session.title === undefined ? null : <>{key} · </>}
                  {`From ${session.workspaceName} · ${session.agentNames.join(', ')}`}
                </span>
                <span>{`Started ${startedOf(session.startedAt)} · ${spanOf(session)}`}</span>
              </span>
            }
            meta={
              <span className="flex items-center gap-4 text-foreground/60 text-xs tabular-nums">
                <span>{runCount}</span>
                {session.failedRunCount > 0 ? (
                  <span className="text-destructive" title={session.lastError ?? undefined}>
                    {`${formatCount(session.failedRunCount)} failed`}
                  </span>
                ) : null}
                {session.cancelledRunCount > 0 ? (
                  <span>{`${formatCount(session.cancelledRunCount)} cancelled`}</span>
                ) : null}
                <span title="The time its runs took, added up">{formatDuration(session.runMs)}</span>
                <span>{formatTokens(session)}</span>
                <RunStatusBadge status={session.openRunCount > 0 ? RunStatus.Running : session.lastStatus} />
              </span>
            }
            contentSlot={<SessionRuns session={session} />}
          />
        );
      })}
    />
  );
}
