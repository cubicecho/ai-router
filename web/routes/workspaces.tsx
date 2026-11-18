import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { WorkspacesDocument } from '@/__generated__/graphql';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Button } from '@/components/ui/button';
import { Layers, Plus } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { WorkspaceDialog } from '@/workspaces/workspace-dialog';

/**
 * Says how many keys a workspace has.
 *
 * @param count - The number of keys.
 * @returns "No keys", "1 key" or "3 keys".
 */
function keyCount(count: number): string {
  if (count === 0) {
    return 'No keys';
  }
  return count === 1 ? '1 key' : `${count} keys`;
}

/** Every workspace, each opening onto its keys. */
export function WorkspacesRoute() {
  const [isCreating, setIsCreating] = useState(false);
  const workspaces = useQuery({ queryKey: ['workspaces'], queryFn: () => request(WorkspacesDocument) });
  const rows = workspaces.data?.workspaces ?? [];
  const create = (
    <Button variant="positive" iconSlot={<Plus />} onClick={() => setIsCreating(true)} content="New workspace" />
  );

  return (
    <PageLayout
      width="prose"
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
                iconSlot={<Layers />}
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
                meta={keyCount(workspace.keysAggregate.count)}
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
