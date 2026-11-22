import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { type ReactElement, useState } from 'react';
import { AgentDocument, DeleteAgentDocument } from '@/__generated__/graphql';
import { AgentEditorDialog } from '@/agents/agent-editor-dialog';
import { AgentOverview } from '@/agents/agent-overview';
import { AgentUsageSection } from '@/agents/agent-usage-section';
import { AgentWorkspacesSection } from '@/agents/agent-workspaces-section';
import { DraftsSection } from '@/agents/drafts-section';
import { HistorySection } from '@/agents/history-section';
import { RevisionStanding, standingOf } from '@/agents/revisions';
import { AGENT_TAB_LABELS, AGENT_TABS, type AgentTab } from '@/agents/search';
import { factsOf } from '@/agents/shapes';
import { ConfirmButton } from '@/components/confirm-button';
import { DetailTabBar, DetailTabPanel, DetailTabs, useDetailTab } from '@/components/detail-tabs';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { PageTitle } from '@/components/page-title';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Pencil } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { RecentRunsSection } from '@/runs/recent-runs-section';
import { RUNS_PER_PAGE } from '@/runs/search';
import { useRunCount } from '@/runs/use-runs';

/** One agent, in tabs: its live revision, its drafts and history, the workspaces offering it, its runs and usage. */
export function AgentRoute() {
  const { agentId } = useParams({ from: '/app/agents/$agentId' });
  const navigate = useNavigate({ from: '/agents/$agentId' });
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const agent = useQuery({
    queryKey: ['agents', agentId],
    queryFn: () => request(AgentDocument, { id: agentId }),
  });
  const remove = useMutation({
    mutationFn: () => request(DeleteAgentDocument, { id: agentId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      void navigate({ to: '/agents' });
    },
  });
  const { tab, showTab } = useDetailTab(AGENT_TABS);
  const record = agent.data?.agent ?? undefined;
  // The same request the Runs tab makes, so the count costs nothing more once it is open.
  const runCount = useRunCount({ agentName: { eq: record?.name ?? '' } }, record !== undefined);
  const back = (
    <Button variant="outline" size="sm" iconSlot={<ArrowLeft />} linkSlot={<Link to="/agents" />} content="Agents" />
  );

  if (record === undefined) {
    return (
      <PageLayout
        title="Agent"
        backSlot={back}
        width="page"
        loading={agent.isPending}
        contentSlot={
          <LoadState query={agent} what="this agent" record={record} notFoundLabel="Agent not found" level={2} />
        }
      />
    );
  }

  const live = record.liveRevision ?? null;
  // With none live, the editor starts from the newest revision rather than from nothing.
  const newest = record.revisions[0] ?? null;
  const facts = factsOf(live?.document);
  const displayName = facts.name ?? record.name;
  const liveRevisionId = record.liveRevisionId ?? null;
  const drafts = record.revisions.filter((revision) => standingOf(revision, liveRevisionId) === RevisionStanding.Draft);
  const trailing: Partial<Record<AgentTab, ReactElement>> = {
    drafts: drafts.length > 0 ? <Badge variant="info-soft">{drafts.length}</Badge> : undefined,
    history: <Badge variant="secondary">{record.revisions.length}</Badge>,
    workspaces: <Badge variant="secondary">{record.workspaces.length}</Badge>,
    runs: runCount === undefined ? undefined : <Badge variant="secondary">{runCount}</Badge>,
  };

  return (
    <DetailTabs value={tab} onValueChange={showTab}>
      <PageLayout
        title={
          <PageTitle
            title={displayName}
            badgesSlot={
              <>
                {liveRevisionId === null ? <Badge variant="warning-soft">Can't run</Badge> : null}
                {record.workspaces.length === 0 ? <Badge variant="warning-soft">In no workspace</Badge> : null}
              </>
            }
          />
        }
        description={facts.description ?? undefined}
        backSlot={back}
        width="page"
        actionSlot={
          <>
            <Button variant="outline" iconSlot={<Pencil />} onClick={() => setIsEditing(true)} content="Edit" />
            <ConfirmButton
              title={`Delete ${record.name}?`}
              description="Every revision goes with it, and the workspaces offering it stop doing so. Apps that run it are refused from their next request."
              requireText={record.name}
              onConfirm={() => remove.mutate()}
              content="Delete"
            />
          </>
        }
        headerBarSlot={
          <DetailTabBar tabs={AGENT_TABS} labels={AGENT_TAB_LABELS} label={`${displayName} tabs`} trailing={trailing} />
        }
        contentSlot={
          <>
            <DetailTabPanel value="overview">
              <AgentOverview agent={record} />
            </DetailTabPanel>
            <DetailTabPanel value="drafts">
              <DraftsSection agentId={record.id} autoPromote={record.autoPromote} drafts={drafts} />
            </DetailTabPanel>
            <DetailTabPanel value="history">
              <HistorySection liveRevisionId={liveRevisionId} revisions={record.revisions} />
            </DetailTabPanel>
            <DetailTabPanel value="workspaces">
              <AgentWorkspacesSection
                agent={record}
                displayName={displayName}
                workspaceServers={agent.data?.agentWorkspaceServers ?? []}
                disabledServers={agent.data?.agentDisabledServers ?? []}
              />
            </DetailTabPanel>
            <DetailTabPanel value="runs">
              <RecentRunsSection
                where={{ agentName: { eq: record.name } }}
                search={{ agent: record.name }}
                hide="agent"
                limit={RUNS_PER_PAGE}
              />
            </DetailTabPanel>
            <DetailTabPanel value="usage">
              <AgentUsageSection agentId={record.id} />
            </DetailTabPanel>
            {isEditing ? (
              <AgentEditorDialog
                open
                onOpenChange={setIsEditing}
                agent={{ id: record.id, name: record.name, document: (live ?? newest)?.document ?? null }}
              />
            ) : null}
          </>
        }
      />
    </DetailTabs>
  );
}
