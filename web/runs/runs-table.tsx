import { Link } from '@tanstack/react-router';
import type { RunRowFieldsFragment } from '@/__generated__/graphql';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RunStatusBadge } from './run-status-badge';
import { durationOf, formatDuration, formatTokens, isOpen, shortError, startedOf } from './shapes';

/** A column a phone leaves out, so the run, its agent and its status fit without scrolling sideways. */
const WIDE_ONLY = 'hidden md:table-cell';

/** How a link inside a table cell is drawn, so it reads as one without a hover. */
export const CELL_LINK_CLASS = 'underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground';

/** What the table is given. */
export interface RunsTableProps {
  /** The runs, newest first. */
  rows: readonly RunRowFieldsFragment[];
  /** The time a running run's duration is measured to. */
  now: number;
  /** What the table is a list of, for a screen reader. */
  caption: string;
  /** Leaves out the agent column, on a page that is already about one agent. */
  hideAgent?: boolean | undefined;
  /** Leaves out the workspace column, on a page that is already about one workspace. */
  hideWorkspace?: boolean | undefined;
}

/**
 * Names a run's agent, linked to its page while it still exists.
 *
 * @param run - The run.
 * @returns The link, or the name alone for a deleted agent.
 */
function AgentCell({ run }: { run: RunRowFieldsFragment }) {
  if (run.agentId === null) {
    return <span title="This agent was deleted">{run.agentName}</span>;
  }
  return (
    <Link to="/agents/$agentId" params={{ agentId: run.agentId }} className={CELL_LINK_CLASS}>
      {run.agentName}
    </Link>
  );
}

/**
 * Names a run's workspace, linked to its page while it still exists.
 *
 * @param run - The run.
 * @returns The link, or the name alone for a deleted workspace.
 */
function WorkspaceCell({ run }: { run: RunRowFieldsFragment }) {
  if (run.workspaceId === null) {
    return <span title="This workspace was deleted">{run.workspaceName}</span>;
  }
  return (
    <Link to="/workspaces/$workspaceId" params={{ workspaceId: run.workspaceId }} className={CELL_LINK_CLASS}>
      {run.workspaceName}
    </Link>
  );
}

/** Runs, one row each: when it started (opening the run), its agent and workspace, how long, its tokens and status. */
export function RunsTable({ rows, now, caption, hideAgent = false, hideWorkspace = false }: RunsTableProps) {
  return (
    <Table>
      <TableCaption className="sr-only">{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Started</TableHead>
          {hideAgent ? null : <TableHead>Agent</TableHead>}
          {hideWorkspace ? null : <TableHead className={WIDE_ONLY}>Workspace</TableHead>}
          <TableHead className={`${WIDE_ONLY} text-right`}>Took</TableHead>
          <TableHead className={`${WIDE_ONLY} text-right`}>Tokens</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((run) => {
          const isRunning = isOpen(run.status);
          return (
            <TableRow key={run.id}>
              <TableHead className="whitespace-nowrap font-normal text-xs">
                <Link to="/agent-runs/$runId" params={{ runId: run.id }} className={CELL_LINK_CLASS}>
                  {startedOf(run.startedAt)}
                </Link>
              </TableHead>
              {hideAgent ? null : (
                <TableCell className="font-mono text-xs">
                  <AgentCell run={run} />
                </TableCell>
              )}
              {hideWorkspace ? null : (
                <TableCell className={`${WIDE_ONLY} font-mono text-xs`}>
                  <WorkspaceCell run={run} />
                </TableCell>
              )}
              <TableCell className={`${WIDE_ONLY} whitespace-nowrap text-right text-xs`}>
                {formatDuration(durationOf(run, now))}
                {isRunning ? <span className="text-foreground/60"> so far</span> : null}
              </TableCell>
              <TableCell className={`${WIDE_ONLY} whitespace-nowrap text-right text-xs`}>
                {formatTokens(run)}
                {isRunning ? <span className="text-foreground/60"> so far</span> : null}
              </TableCell>
              <TableCell className="text-xs">
                <span className="grid justify-items-start gap-1">
                  <RunStatusBadge status={run.status} />
                  {run.error === null ? null : (
                    <span className="max-w-64 text-foreground/70" title={run.error}>
                      {shortError(run.error)}
                    </span>
                  )}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
