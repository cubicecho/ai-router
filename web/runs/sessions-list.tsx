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
import { formatCount, formatTokens, isOpen, RunStatus, startedOf } from './shapes';
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
 * Sessions, one closed row each: its key, where it came from, its agents, how many runs and tokens, and whether one is
 * still going. A row opens onto its runs.
 */
export function SessionsList({ sessions }: SessionsListProps) {
  const rows = useOpenRows<string>();
  return (
    <List
      label="Sessions"
      contentSlot={sessions.map((session) => {
        const id = `${session.workspaceId ?? session.workspaceName}/${session.key}`;
        const runCount = `${formatCount(session.runCount)} ${session.runCount === 1 ? 'run' : 'runs'}`;
        return (
          <CollapsibleRow
            key={id}
            open={rows.isOpen(id)}
            onOpenChange={(next) => rows.setOpen(id, next)}
            title={<span className="font-mono">{session.key}</span>}
            description={
              <span className="grid gap-0.5 text-foreground/60 text-sm">
                <span>{`From ${session.workspaceName} · ${session.agentNames.join(', ')}`}</span>
                <span>{`Latest run ${startedOf(session.lastStartedAt)}`}</span>
              </span>
            }
            meta={
              <span className="flex items-center gap-4 text-foreground/60 text-xs tabular-nums">
                <span>{runCount}</span>
                <span>{formatTokens(session)}</span>
                {session.openRunCount > 0 ? <RunStatusBadge status={RunStatus.Running} /> : null}
              </span>
            }
            contentSlot={<SessionRuns session={session} />}
          />
        );
      })}
    />
  );
}
