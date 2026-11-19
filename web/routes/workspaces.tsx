import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { WorkspacesDocument, type WorkspacesQuery } from '@/__generated__/graphql';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KeyRound, Plus } from '@/components/ui/icons';
import { countOf } from '@/lib/format';
import { request } from '@/lib/gql';
import { WorkspaceDialog } from '@/workspaces/workspace-dialog';

/** One row of the workspaces list, as its query answers it. */
type WorkspaceRow = WorkspacesQuery['workspaces'][number];

/**
 * What a workspace holds, in a line: its agents, its MCP Servers entries and its runs, then a badge
 * for what stops its apps calling at all.
 *
 * @param workspace - The row.
 * @returns The row's far end.
 */
function metaOf(workspace: WorkspaceRow) {
  const keys = workspace.keysAggregate.count;
  return (
    <span className="flex items-center gap-2 text-foreground/60 text-xs">
      <span>
        {[
          countOf(workspace.agentsAggregate.count, 'agent', 'agents'),
          countOf(workspace.serversAggregate.count, 'MCP Server', 'MCP Servers'),
          countOf(workspace.runsAggregate.count, 'run', 'runs'),
        ].join(' · ')}
      </span>
      {keys === 0 ? (
        <Badge variant="warning-soft">No keys</Badge>
      ) : (
        <Badge variant="secondary">{countOf(keys, 'key', 'keys')}</Badge>
      )}
    </span>
  );
}

/** Every workspace, each opening onto its agents, keys, MCP Servers and usage. */
export function WorkspacesRoute() {
  const [isCreating, setIsCreating] = useState(false);
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => request(WorkspacesDocument) });
  const rows = workspaces.data?.workspaces ?? [];
  const create = (
    <Button variant="positive" iconSlot={<Plus />} onClick={() => setIsCreating(true)} content="New workspace" />
  );

  return (
    <PageLayout
      width="page"
      title="Workspaces"
      description="What each app sees: the agents, models and servers it may use, and the keys it calls with."
      actionSlot={rows.length > 0 ? create : undefined}
      contentSlot={
        <>
          <LoadState
            query={workspaces}
            what="the workspaces"
            count={rows.length}
            emptySlot={
              <EmptyState
                iconSlot={<KeyRound />}
                title="No workspaces yet"
                description="Make one for each app that will use the router, then give it a key."
                actionSlot={create}
              />
            }
          />
          <List
            label="Workspaces"
            contentSlot={rows.map((workspace) => (
              <ListItem
                key={workspace.id}
                title={workspace.name}
                description={workspace.description === '' ? workspace.slug : workspace.description}
                meta={metaOf(workspace)}
                linkSlot={<Link to="/workspaces/$workspaceId" params={{ workspaceId: workspace.id }} />}
              />
            ))}
          />
          <WorkspaceDialog open={isCreating} onOpenChange={setIsCreating} workspace={null} />
        </>
      }
    />
  );
}
