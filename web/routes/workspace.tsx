import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import {
  DeleteWorkspaceDocument,
  MeDocument,
  UsageByWorkspaceDocument,
  WorkspaceDocument,
} from '@/__generated__/graphql';
import { WorkspaceAgentsSection } from '@/agents/workspace-agents-section';
import { ConfirmButton } from '@/components/confirm-button';
import { DetailTabBar, DetailTabPanel, DetailTabs, useDetailTab } from '@/components/detail-tabs';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { ArrowLeft, Pencil } from '@/components/ui/icons';
import { formatDate } from '@/lib/format';
import { request } from '@/lib/gql';
import { Role } from '@/lib/roles';
import { UsageSection } from '@/models/usage-section';
import { RecentRunsSection } from '@/runs/recent-runs-section';
import { WorkspaceServersSection } from '@/tools/workspace-servers-section';
import { WORKSPACE_TABS, type WorkspaceTab } from '@/workspaces/tabs';
import { WorkspaceDialog } from '@/workspaces/workspace-dialog';
import { WorkspaceKeysSection } from '@/workspaces/workspace-keys-section';

/** What each tab is called. "MCP" is the workspace's MCP Servers entries. */
const TAB_LABELS = {
  agents: 'Agents',
  keys: 'Keys',
  mcp: 'MCP',
  usage: 'Usage',
} as const satisfies Record<WorkspaceTab, string>;

/** The tabs whose label is followed by how many rows they hold. */
type CountedTab = Exclude<WorkspaceTab, 'usage'>;

/** One workspace, in tabs: the agents its apps may run, the keys they call with, its MCP Servers and its usage. */
export function WorkspaceRoute() {
  const { workspaceId } = useParams({ from: '/app/workspaces/$workspaceId' });
  const navigate = useNavigate({ from: '/workspaces/$workspaceId' });
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const { tab, showTab } = useDetailTab(WORKSPACE_TABS);
  const me = useQuery({ queryKey: ['me'], queryFn: () => request(MeDocument) });
  const workspace = useQuery({
    queryKey: ['workspaces', workspaceId],
    queryFn: () => request(WorkspaceDocument, { id: workspaceId }),
  });
  const usage = useQuery({
    queryKey: ['usage', 'workspace', workspaceId],
    queryFn: () => request(UsageByWorkspaceDocument, { workspaceId }),
  });
  const remove = useMutation({
    mutationFn: () => request(DeleteWorkspaceDocument, { id: workspaceId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      void navigate({ to: '/workspaces' });
    },
  });
  const record = workspace.data?.workspace ?? undefined;
  const back = (
    <Button
      variant="outline"
      size="sm"
      iconSlot={<ArrowLeft />}
      linkSlot={<Link to="/workspaces" />}
      content="Workspaces"
    />
  );

  if (record === undefined) {
    return (
      <PageLayout
        width="page"
        title="Workspace"
        backSlot={back}
        loading={workspace.isPending}
        contentSlot={
          <LoadState
            query={workspace}
            what="this workspace"
            record={record}
            notFoundLabel="Workspace not found"
            level={2}
          />
        }
      />
    );
  }

  const counts = {
    agents: record.agentsAggregate.count,
    keys: record.keys.length,
    mcp: record.serversAggregate.count,
  } satisfies Record<CountedTab, number>;

  return (
    <DetailTabs value={tab} onValueChange={showTab}>
      <PageLayout
        width="page"
        title={record.name}
        description={record.description === '' ? undefined : record.description}
        backSlot={back}
        actionSlot={
          <>
            <Button variant="outline" iconSlot={<Pencil />} onClick={() => setIsEditing(true)} content="Edit" />
            <ConfirmButton
              title={`Delete ${record.name}?`}
              description="Its keys stop working at once, and every app using them is refused."
              requireText={record.slug}
              onConfirm={() => remove.mutate()}
              content="Delete"
            />
          </>
        }
        headerBarSlot={
          <DetailTabBar
            tabs={WORKSPACE_TABS}
            labels={TAB_LABELS}
            label={`${record.name}'s sections`}
            trailing={{
              agents: <Badge variant="secondary">{counts.agents}</Badge>,
              keys: <Badge variant="secondary">{counts.keys}</Badge>,
              mcp: <Badge variant="secondary">{counts.mcp}</Badge>,
            }}
            leadSlot={
              <PropertyList
                contentSlot={
                  <>
                    <PropertyRow
                      label="Slug"
                      value={record.slug}
                      valueClassName="font-mono"
                      actionSlot={<CopyButton value={record.slug} label="Copy slug" />}
                    />
                    <PropertyRow label="Created" value={formatDate(record.createdAt)} />
                  </>
                }
              />
            }
          />
        }
        contentSlot={
          <>
            <DetailTabPanel value="agents">
              <WorkspaceAgentsSection workspaceId={record.id} />
            </DetailTabPanel>
            <DetailTabPanel value="keys">
              <WorkspaceKeysSection workspaceId={record.id} keys={record.keys} />
            </DetailTabPanel>
            <DetailTabPanel value="mcp">
              <WorkspaceServersSection workspaceId={record.id} isAdmin={me.data?.me.role === Role.Admin} />
            </DetailTabPanel>
            <DetailTabPanel value="usage" className="gap-6">
              <UsageSection
                rows={usage.data?.usageCounts ?? []}
                groupBy={(row) => `${row.providerName}/${row.model}`}
                groupLabel="Model"
              />
              <RecentRunsSection
                where={{ workspaceId: { eq: record.id } }}
                search={{ workspace: record.id }}
                hide="workspace"
              />
            </DetailTabPanel>
            <WorkspaceDialog open={isEditing} onOpenChange={setIsEditing} workspace={record} />
          </>
        }
      />
    </DetailTabs>
  );
}
