import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { RunFilterChoicesDocument, type RunFilters } from '@/__generated__/graphql';
import { displayNameOf } from '@/agents/shapes';
import { Combobox } from '@/components/combobox';
import { EmptyState } from '@/components/empty-state';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { Activity, ChevronLeft, ChevronRight, X } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { menuValueOf, storedValueOf, withEmptyOption, withOrphanOptions } from '@/lib/select-options';
import { RunsTable } from '@/runs/runs-table';
import { RUNS_PER_PAGE, type RunsSearch } from '@/runs/search';
import { formatCount, RUN_STATUS_CHOICES, RunStatus, statusOf } from '@/runs/shapes';
import { useNow, useRuns } from '@/runs/use-runs';

/**
 * Builds the `runs` query's filter.
 *
 * @param search - The filters.
 * @returns The `where` that matches them.
 */
function whereOf(search: RunsSearch): RunFilters {
  return {
    ...(search.agent === undefined ? {} : { agentName: { eq: search.agent } }),
    ...(search.workspace === undefined ? {} : { workspaceId: { eq: search.workspace } }),
    ...(search.status === undefined ? {} : { status: { eq: search.status } }),
  };
}

/** Recent agent runs, newest first, filtered by agent, workspace and status, a page at a time. */
export function RunsRoute() {
  const search = useSearch({ from: '/app/agent-runs' });
  const navigate = useNavigate({ from: '/agent-runs' });
  const page = search.page ?? 1;
  const runs = useRuns({ where: whereOf(search), limit: RUNS_PER_PAGE, offset: (page - 1) * RUNS_PER_PAGE });
  const choices = useQuery({ queryKey: ['runs', 'filter-choices'], queryFn: () => request(RunFilterChoicesDocument) });
  const rows = runs.data?.runs ?? [];
  const total = runs.data?.runsAggregate.count ?? 0;
  const now = useNow(rows.some((run) => run.status === RunStatus.Running));
  const isFiltered = search.agent !== undefined || search.workspace !== undefined || search.status !== undefined;
  const pages = Math.max(1, Math.ceil(total / RUNS_PER_PAGE));

  /** Changes one filter, and goes back to the first page. */
  const filter = (next: Partial<RunsSearch>) => {
    void navigate({ search: (previous) => ({ ...previous, ...next, page: undefined }) });
  };
  const toPage = (next: number) => {
    void navigate({ search: (previous) => ({ ...previous, page: next > 1 ? next : undefined }) });
  };
  const clear = (
    <Button
      variant="outline"
      size="sm"
      iconSlot={<X />}
      onClick={() => void navigate({ search: {} })}
      content="Clear filters"
    />
  );

  const agents = choices.data?.agents ?? [];
  const workspaces = choices.data?.workspaces ?? [];
  const agentOptions = withOrphanOptions(
    agents.map((agent) => ({ value: agent.name, label: displayNameOf(agent), meta: agent.name })),
    search.agent === undefined ? [] : [search.agent],
  );
  const workspaceOptions = workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }));
  const first = (page - 1) * RUNS_PER_PAGE + 1;
  const last = first + rows.length - 1;

  return (
    <PageLayout
      title="Runs"
      description="Every time an app ran an agent: what it ran, for whom, how long it took and how it ended."
      headerContentSlot={
        <div className="grid w-full gap-2 sm:grid-cols-3">
          <Combobox
            className="w-full"
            aria-label="Agent"
            options={withEmptyOption(agentOptions, 'All agents')}
            value={menuValueOf(search.agent)}
            onValueChange={(value) => filter({ agent: storedValueOf(value) ?? undefined })}
          />
          <Combobox
            className="w-full"
            aria-label="Workspace"
            options={withEmptyOption(
              withOrphanOptions(workspaceOptions, search.workspace === undefined ? [] : [search.workspace]),
              'All workspaces',
            )}
            value={menuValueOf(search.workspace)}
            onValueChange={(value) => filter({ workspace: storedValueOf(value) ?? undefined })}
          />
          <Combobox
            className="w-full"
            aria-label="Status"
            options={withEmptyOption(RUN_STATUS_CHOICES, 'Any status')}
            value={menuValueOf(search.status)}
            onValueChange={(value) => filter({ status: statusOf(storedValueOf(value)) })}
          />
        </div>
      }
      footerSlot={
        total > RUNS_PER_PAGE ? (
          <div className="flex items-center justify-between gap-2 text-foreground/70 text-sm">
            <span className="tabular-nums">
              {rows.length === 0
                ? `${formatCount(total)} runs`
                : `${formatCount(first)}–${formatCount(last)} of ${formatCount(total)}`}
            </span>
            <span className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                iconSlot={<ChevronLeft />}
                disabled={page <= 1}
                onClick={() => toPage(page - 1)}
                content="Newer"
              />
              <Button
                variant="outline"
                size="sm"
                iconSlot={<ChevronRight />}
                disabled={page >= pages}
                onClick={() => toPage(page + 1)}
                content="Older"
              />
            </span>
          </div>
        ) : undefined
      }
      contentSlot={
        <>
          <LoadState
            query={runs}
            what="the runs"
            count={rows.length}
            emptySlot={
              isFiltered ? (
                <EmptyState
                  iconSlot={<Activity />}
                  title="No runs match"
                  description="Try another agent, workspace or status."
                  actionSlot={clear}
                />
              ) : (
                <EmptyState
                  iconSlot={<Activity />}
                  title="No runs yet"
                  description="A run starts when an app sends a request to /v1 with an agent as its model."
                />
              )
            }
          />
          {rows.length === 0 ? null : <RunsTable rows={rows} now={now} caption="Runs" />}
        </>
      }
    />
  );
}
