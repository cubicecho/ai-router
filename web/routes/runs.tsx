import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { RunFilterChoicesDocument, type RunFilters, RunSessionsDocument } from '@/__generated__/graphql';
import { displayNameOf } from '@/agents/shapes';
import { CardLayout } from '@/components/card-layout';
import { Combobox } from '@/components/combobox';
import { DetailTabBar, DetailTabPanel, DetailTabs, useDetailTab } from '@/components/detail-tabs';
import { EmptyState } from '@/components/empty-state';
import { FilterBar } from '@/components/filter-bar';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { Activity, Layers, X } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { menuValueOf, storedValueOf, withEmptyOption, withOrphanOptions } from '@/lib/select-options';
import { Pager } from '@/runs/pager';
import { RunsList } from '@/runs/runs-list';
import { RUNS_PER_PAGE, RUNS_TAB_LABELS, RUNS_TABS, type RunsSearch } from '@/runs/search';
import { SessionsList } from '@/runs/sessions-list';
import { isOpen, RUN_STATUS_CHOICES, statusOf } from '@/runs/shapes';
import { useNow, useRuns } from '@/runs/use-runs';

/** How often the Sessions tab is read again while a session on it has a run going. */
const LIVE_REFETCH_MS = 2000;

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
    ...(search.session === undefined ? {} : { sessionKey: { eq: search.session } }),
  };
}

/**
 * Recent agent runs, newest first, a page at a time, filtered by agent, workspace, status and session; or the same runs
 * grouped into the sessions the apps sent them under.
 */
export function RunsRoute() {
  const search = useSearch({ from: '/app/agent-runs' });
  const navigate = useNavigate({ from: '/agent-runs' });
  const { tab } = useDetailTab(RUNS_TABS);
  const isSessions = tab === 'sessions';
  const page = search.page ?? 1;
  const offset = (page - 1) * RUNS_PER_PAGE;
  const runs = useRuns({ where: whereOf(search), limit: RUNS_PER_PAGE, offset, enabled: isSessions === false });
  const sessions = useQuery({
    queryKey: ['runs', 'sessions', search.workspace, search.agent, page],
    queryFn: () =>
      request(RunSessionsDocument, {
        workspaceId: search.workspace,
        agentName: search.agent,
        limit: RUNS_PER_PAGE,
        offset,
      }),
    enabled: isSessions,
    refetchInterval: (query) =>
      query.state.data?.runSessions.sessions.some((session) => session.openRunCount > 0) ? LIVE_REFETCH_MS : false,
    placeholderData: (previous) => previous,
  });
  const choices = useQuery({ queryKey: ['runs', 'filter-choices'], queryFn: () => request(RunFilterChoicesDocument) });
  const rows = runs.data?.runs ?? [];
  const total = runs.data?.runsAggregate.count ?? 0;
  const sessionRows = sessions.data?.runSessions.sessions ?? [];
  const sessionTotal = sessions.data?.runSessions.count ?? 0;
  const now = useNow(rows.some((run) => isOpen(run.status)));
  const isGroupFiltered = search.agent !== undefined || search.workspace !== undefined;
  const isFiltered = isGroupFiltered || search.status !== undefined || search.session !== undefined;
  /** Whether a filter the open tab shows is set: the Sessions tab has no status or session filter. */
  const isTabFiltered = isSessions ? isGroupFiltered : isFiltered;

  /** Changes one filter, and goes back to the first page. */
  const filter = (next: Partial<RunsSearch>) => {
    void navigate({ search: (previous) => ({ ...previous, ...next, page: undefined }) });
  };
  const toPage = (next: number) => {
    void navigate({ search: (previous) => ({ ...previous, page: next > 1 ? next : undefined }) });
  };
  /** Opens a tab on its first page, keeping the filters. */
  const toTab = (value: string) => {
    const next = RUNS_TABS.find((candidate) => candidate === value);
    if (next !== undefined) {
      const [first] = RUNS_TABS;
      filter({ tab: next === first ? undefined : next });
    }
  };
  /** Puts every filter back, staying on the open tab. */
  const clearFilters = () => {
    void navigate({ search: { tab: search.tab } });
  };
  const clear = <Button variant="outline" size="sm" iconSlot={<X />} onClick={clearFilters} content="Clear filters" />;

  const agents = choices.data?.agents ?? [];
  const workspaces = choices.data?.workspaces ?? [];
  const agentOptions = withOrphanOptions(
    agents.map((agent) => ({ value: agent.name, label: displayNameOf(agent), meta: agent.name })),
    search.agent === undefined ? [] : [search.agent],
  );
  const workspaceOptions = workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }));
  const shown = isSessions ? sessionRows.length : rows.length;
  const matching = isSessions ? sessionTotal : total;

  return (
    <DetailTabs value={tab} onValueChange={toTab}>
      <PageLayout
        title="Runs"
        width="page"
        description="Every time an app ran an agent: what it ran, for whom, how long it took and how it ended."
        headerContentSlot={
          <FilterBar
            isFiltered={isTabFiltered}
            onClear={clearFilters}
            contentSlot={
              <>
                <Combobox
                  className="w-48"
                  aria-label="Agent"
                  options={withEmptyOption(agentOptions, 'All agents')}
                  value={menuValueOf(search.agent)}
                  onValueChange={(value) => filter({ agent: storedValueOf(value) ?? undefined })}
                />
                <Combobox
                  className="w-48"
                  aria-label="Workspace"
                  options={withEmptyOption(
                    withOrphanOptions(workspaceOptions, search.workspace === undefined ? [] : [search.workspace]),
                    'All workspaces',
                  )}
                  value={menuValueOf(search.workspace)}
                  onValueChange={(value) => filter({ workspace: storedValueOf(value) ?? undefined })}
                />
                {isSessions ? null : (
                  <Combobox
                    className="w-48"
                    aria-label="Status"
                    options={withEmptyOption(RUN_STATUS_CHOICES, 'Any status')}
                    value={menuValueOf(search.status)}
                    onValueChange={(value) => filter({ status: statusOf(storedValueOf(value)) })}
                  />
                )}
                {isSessions || search.session === undefined ? null : (
                  <Button
                    variant="outline"
                    iconSlot={<X />}
                    onClick={() => filter({ session: undefined })}
                    content={<span className="truncate font-mono">{search.session}</span>}
                    aria-label={`Show every session, not only ${search.session}`}
                  />
                )}
              </>
            }
          />
        }
        headerBarSlot={<DetailTabBar tabs={RUNS_TABS} labels={RUNS_TAB_LABELS} label="Runs, or sessions" />}
        footerSlot={
          matching > RUNS_PER_PAGE ? (
            <Pager
              page={page}
              perPage={RUNS_PER_PAGE}
              shown={shown}
              total={matching}
              what={isSessions ? 'sessions' : 'runs'}
              onPage={toPage}
            />
          ) : undefined
        }
        contentSlot={
          <>
            <DetailTabPanel value="runs">
              <LoadState
                query={runs}
                what="the runs"
                count={rows.length}
                emptySlot={
                  isFiltered ? (
                    <EmptyState
                      iconSlot={<Activity />}
                      title="No runs match"
                      description="Try another agent, workspace, status or session."
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
              {rows.length > 0 ? (
                <CardLayout
                  level={2}
                  title={isFiltered ? 'Matching runs' : 'All runs'}
                  contentSlot={<RunsList rows={rows} now={now} label="Runs" />}
                />
              ) : null}
            </DetailTabPanel>
            <DetailTabPanel value="sessions">
              <LoadState
                query={sessions}
                what="the sessions"
                count={sessionRows.length}
                emptySlot={
                  isGroupFiltered ? (
                    <EmptyState
                      iconSlot={<Layers />}
                      title="No sessions match"
                      description="Try another agent or workspace."
                      actionSlot={clear}
                    />
                  ) : (
                    <EmptyState
                      iconSlot={<Layers />}
                      title="No sessions yet"
                      description="An app's runs form a session when it sends them under one X-Session-Id or X-Conversation-Id, as agent-core apps do."
                    />
                  )
                }
              />
              {sessionRows.length > 0 ? (
                <CardLayout
                  level={2}
                  title={isGroupFiltered ? 'Matching sessions' : 'All sessions'}
                  description="The runs an app said belong together, such as one chat or one task, whichever agents ran them. The latest first."
                  contentSlot={<SessionsList sessions={sessionRows} />}
                />
              ) : null}
            </DetailTabPanel>
          </>
        }
      />
    </DetailTabs>
  );
}
