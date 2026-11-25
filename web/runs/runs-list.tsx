import { Link } from '@tanstack/react-router';
import type { RunRowFieldsFragment } from '@/__generated__/graphql';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { RowMeta } from '@/components/row-meta';
import { joinStats } from '@/lib/format';
import { workerLabelOf } from '@/workers/shapes';
import { RunStatusBadge } from './run-status-badge';
import { durationOf, formatDuration, formatTokens, isOpen, shortError, startedOf } from './shapes';

/** What the list is given. */
export interface RunsListProps {
  /** The runs, newest first. */
  rows: readonly RunRowFieldsFragment[];
  /** The time a running run's duration is measured to. */
  now: number;
  /** What the list is a list of, for a screen reader. */
  label: string;
  /** Leaves the agent out of each row, on a page that is already about one agent. */
  hideAgent?: boolean | undefined;
  /** Leaves the workspace out of each row, on a page that is already about one workspace. */
  hideWorkspace?: boolean | undefined;
}

/**
 * Says where a run came from and when, under its title.
 *
 * @param run - The run.
 * @param hideAgent - Whether its title already is the workspace, so the line leaves it out.
 * @param hideWorkspace - Whether the page is about its workspace.
 * @returns Such as "From task-server · on build-box · 18 Nov 2026, 09:14:05". A run with no worker recorded names
 *   none.
 */
function originOf(run: RunRowFieldsFragment, hideAgent: boolean, hideWorkspace: boolean): string {
  const isWorkspaceNamed = hideAgent || hideWorkspace;
  const from = isWorkspaceNamed ? null : `From ${run.workspaceName}`;
  // Its own fact, so it starts the line when the workspace is left out.
  const on = from === null ? 'On' : 'on';
  return joinStats(from, run.worker === null ? null : `${on} ${workerLabelOf(run.worker)}`, startedOf(run.startedAt));
}

/** Runs, one row each opening the run: its agent, where it came from and when, how long, its tokens and status. */
export function RunsList({ rows, now, label, hideAgent = false, hideWorkspace = false }: RunsListProps) {
  return (
    <List
      label={label}
      contentSlot={rows.map((run) => {
        const isRunning = isOpen(run.status);
        const soFar = isRunning ? ' so far' : '';
        return (
          <ListItem
            key={run.id}
            title={hideAgent ? run.workspaceName : run.agentName}
            titleClassName="font-mono"
            description={
              <span className="grid gap-0.5 text-foreground/60 text-sm">
                <span>{originOf(run, hideAgent, hideWorkspace)}</span>
                {run.error === null ? null : (
                  <span className="line-clamp-1" title={run.error}>
                    {shortError(run.error)}
                  </span>
                )}
              </span>
            }
            meta={
              <RowMeta
                facts={[`${formatDuration(durationOf(run, now))}${soFar}`, `${formatTokens(run)}${soFar}`]}
                badgesSlot={<RunStatusBadge status={run.status} />}
              />
            }
            linkSlot={<Link to="/agent-runs/$runId" params={{ runId: run.id }} />}
          />
        );
      })}
    />
  );
}
