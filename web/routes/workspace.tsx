import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import {
  DeleteWorkspaceDocument,
  MeDocument,
  UsageByWorkspaceDocument,
  WorkspaceDocument,
} from '@/__generated__/graphql';
import { WorkspaceAgentsSection } from '@/agents/workspace-agents-section';
import { ConfirmButton } from '@/components/confirm-button';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { ArrowLeft, Pencil } from '@/components/ui/icons';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDate } from '@/lib/format';
import { request } from '@/lib/gql';
import { Role } from '@/lib/roles';
import { openTab } from '@/lib/tab-search';
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

/**
 * Finds the tab a value names.
 *
 * @param value - What the tabs reported.
 * @returns The tab, or undefined when it names none.
 */
function tabOf(value: string): WorkspaceTab | undefined {
  return WORKSPACE_TABS.find((tab) => tab === value);
}

/** One workspace, in tabs: the agents its apps may run, the keys they call with, its MCP Servers and its usage. */
export function WorkspaceRoute() {
  const { workspaceId } = useParams({ from: '/app/workspaces/$workspaceId' });
  const search = useSearch({ from: '/app/workspaces/$workspaceId' });
  const navigate = useNavigate({ from: '/workspaces/$workspaceId' });
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const tab = openTab(WORKSPACE_TABS, search);
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
        width="full"
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
  const showTab = (value: string) => {
    const next = tabOf(value);
    if (next !== undefined) {
      void navigate({ search: { tab: next }, replace: true });
    }
  };

  return (
    // One root round the whole page, so the triggers in the header name the panes in the body.
    <Tabs value={tab} onValueChange={showTab} className="h-full">
      <PageLayout
        width="full"
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
          <>
            <PropertyList
              className="px-4 pb-3"
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
            <div className="px-4 pb-3">
              <TabsList aria-label={`${record.name}'s sections`}>
                {WORKSPACE_TABS.map((value) => (
                  <TabsTrigger
                    key={value}
                    value={value}
                    trailingSlot={value === 'usage' ? undefined : <Badge variant="secondary">{counts[value]}</Badge>}
                  >
                    {TAB_LABELS[value]}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          </>
        }
        contentSlot={
          <>
            <TabsContent value="agents" className="mt-0">
              <WorkspaceAgentsSection workspaceId={record.id} />
            </TabsContent>
            <TabsContent value="keys" className="mt-0">
              <WorkspaceKeysSection workspaceId={record.id} keys={record.keys} />
            </TabsContent>
            <TabsContent value="mcp" className="mt-0">
              <WorkspaceServersSection workspaceId={record.id} isAdmin={me.data?.me.role === Role.Admin} />
            </TabsContent>
            <TabsContent value="usage" className="mt-0 grid gap-6">
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
            </TabsContent>
            <WorkspaceDialog open={isEditing} onOpenChange={setIsEditing} workspace={record} />
          </>
        }
      />
    </Tabs>
  );
}
