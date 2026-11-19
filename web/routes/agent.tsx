import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
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
import { LoadState } from '@/components/load-state';
import { PageLayout, titleColumn } from '@/components/page-layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Pencil } from '@/components/ui/icons';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { request } from '@/lib/gql';
import { openTab } from '@/lib/tab-search';
import { cn } from '@/lib/utils';
import { RecentRunsSection } from '@/runs/recent-runs-section';
import { RUNS_PER_PAGE } from '@/runs/search';

/** How each tab's panel lays out what it holds: the page body's own gap, and none of the pane's top margin. */
const PANEL_CLASS = 'mt-0 flex flex-col gap-4';

/** One agent, in tabs: its live revision, its drafts and history, the workspaces offering it, its runs and usage. */
export function AgentRoute() {
  const { agentId } = useParams({ from: '/app/agents/$agentId' });
  const search = useSearch({ from: '/app/agents/$agentId' });
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
  const tab = openTab(AGENT_TABS, search);
  const record = agent.data?.agent ?? undefined;
  const back = (
    <Button variant="outline" size="sm" iconSlot={<ArrowLeft />} linkSlot={<Link to="/agents" />} content="Agents" />
  );

  if (record === undefined) {
    return (
      <PageLayout
        title="Agent"
        backSlot={back}
        width="full"
        loading={agent.isPending}
        contentSlot={
          <LoadState query={agent} what="this agent" record={record} notFoundLabel="Agent not found" level={2} />
        }
      />
    );
  }

  /** Opens a tab, replacing the address rather than adding to the history. */
  const showTab = (value: string) => {
    const next = AGENT_TABS.find((candidate) => candidate === value);
    void navigate({ search: { tab: next === AGENT_TABS[0] ? undefined : next }, replace: true });
  };
  const live = record.liveRevision ?? null;
  // With none live, the editor starts from the newest revision rather than from nothing.
  const newest = record.revisions[0] ?? null;
  const facts = factsOf(live?.document);
  const displayName = facts.name ?? record.name;
  const liveRevisionId = record.liveRevisionId ?? null;
  const drafts = record.revisions.filter((revision) => standingOf(revision, liveRevisionId) === RevisionStanding.Draft);
  const trailing: Partial<Record<AgentTab, ReactElement>> = {
    drafts: drafts.length > 0 ? <Badge variant="info-soft">{drafts.length}</Badge> : undefined,
    workspaces:
      record.workspaces.length === 0 ? <Badge variant="warning-soft" label="No workspace offers it" /> : undefined,
  };

  return (
    <Tabs value={tab} onValueChange={showTab} className="h-full">
      <PageLayout
        title={displayName}
        description={facts.description ?? undefined}
        backSlot={back}
        width="full"
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
          <div className={cn(titleColumn('full'), 'pb-3')}>
            <TabsList aria-label={`${displayName} tabs`}>
              {AGENT_TABS.map((value) => (
                <TabsTrigger key={value} value={value} trailingSlot={trailing[value]}>
                  {AGENT_TAB_LABELS[value]}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        }
        contentSlot={
          <>
            <TabsContent value="overview" className={PANEL_CLASS}>
              <AgentOverview agent={record} />
            </TabsContent>
            <TabsContent value="drafts" className={PANEL_CLASS}>
              <DraftsSection agentId={record.id} autoPromote={record.autoPromote} drafts={drafts} />
            </TabsContent>
            <TabsContent value="history" className={PANEL_CLASS}>
              <HistorySection liveRevisionId={liveRevisionId} revisions={record.revisions} />
            </TabsContent>
            <TabsContent value="workspaces" className={PANEL_CLASS}>
              <AgentWorkspacesSection agent={record} displayName={displayName} />
            </TabsContent>
            <TabsContent value="runs" className={PANEL_CLASS}>
              <RecentRunsSection
                where={{ agentName: { eq: record.name } }}
                search={{ agent: record.name }}
                hide="agent"
                limit={RUNS_PER_PAGE}
              />
            </TabsContent>
            <TabsContent value="usage" className={PANEL_CLASS}>
              <AgentUsageSection agentId={record.id} />
            </TabsContent>
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
    </Tabs>
  );
}
