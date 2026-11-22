import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { WorkspacesDocument, type WorkspacesQuery } from '@/__generated__/graphql';
import { CardLayout } from '@/components/card-layout';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { RowMeta, rowNameFact } from '@/components/row-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KeyRound, Plus } from '@/components/ui/icons';
import { formatCount } from '@/lib/format';
import { request } from '@/lib/gql';
import { WorkspaceDialog } from '@/workspaces/workspace-dialog';

/** One row of the workspaces list, as its query answers it. */
type WorkspaceRow = WorkspacesQuery['workspaces'][number];

/**
 * What a workspace holds: its slug (when its name differs), its agents, MCP Servers entries, keys and runs, then a badge for what stops its
 * apps calling at all.
 *
 * @param workspace - The row.
 * @returns The row's far end.
 */
function metaOf(workspace: WorkspaceRow) {
  const keys = workspace.keysAggregate.count;
  return (
    <RowMeta
      facts={[
        rowNameFact(workspace.name, workspace.slug),
        formatCount(workspace.agentsAggregate.count, 'agent', 'agents'),
        formatCount(workspace.serversAggregate.count, 'MCP Server', 'MCP Servers'),
        formatCount(keys, 'key', 'keys'),
        formatCount(workspace.runsAggregate.count, 'run', 'runs'),
      ]}
      badgesSlot={keys === 0 ? <Badge variant="warning-soft">No keys</Badge> : null}
    />
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
          {rows.length > 0 ? (
            <CardLayout
              level={2}
              title="All workspaces"
              contentSlot={
                <List
                  label="Workspaces"
                  contentSlot={rows.map((workspace) => (
                    <ListItem
                      key={workspace.id}
                      title={workspace.name}
                      description={workspace.description === '' ? undefined : workspace.description}
                      meta={metaOf(workspace)}
                      linkSlot={<Link to="/workspaces/$workspaceId" params={{ workspaceId: workspace.id }} />}
                    />
                  ))}
                />
              }
            />
          ) : null}
          <WorkspaceDialog open={isCreating} onOpenChange={setIsCreating} workspace={null} copyChoices={rows} />
        </>
      }
    />
  );
}
