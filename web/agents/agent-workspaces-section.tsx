import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { AgentWorkspaceChoicesDocument, DeleteWorkspaceAgentDocument } from '@/__generated__/graphql';
import { CardLayout } from '@/components/card-layout';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import type { AgentRecord } from './agent-overview';
import { AgentWorkspaceDialog } from './agent-workspace-dialog';

/** What the section is given. */
export interface AgentWorkspacesSectionProps {
  agent: AgentRecord;
  /** What the agent is called on screen. */
  displayName: string;
}

/** The workspaces offering an agent: the only ones whose apps may run it. Untitled: its tab names it. */
export function AgentWorkspacesSection({ agent, displayName }: AgentWorkspacesSectionProps) {
  const queryClient = useQueryClient();
  const [isAdding, setIsAdding] = useState(false);
  const choices = useQuery({
    queryKey: ['workspaces', 'agent-choices'],
    queryFn: () => request(AgentWorkspaceChoicesDocument),
  });
  const remove = useMutation({
    mutationFn: (id: string) => request(DeleteWorkspaceAgentDocument, { id }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
  const offeredIn = new Set(
    agent.workspaces.flatMap((entry) => (entry.workspace === null ? [] : [entry.workspace.id])),
  );
  const available = (choices.data?.workspaces ?? []).filter((workspace) => offeredIn.has(workspace.id) === false);
  const isEveryWorkspace = choices.data !== undefined && available.length === 0;
  const add = (
    <Button
      variant="positive"
      size="sm"
      iconSlot={<Plus />}
      onClick={() => setIsAdding(true)}
      disabled={choices.isPending || isEveryWorkspace}
      hint={isEveryWorkspace ? 'Every workspace offers it already.' : undefined}
      content="Add to workspace"
    />
  );

  return (
    <CardLayout
      level={2}
      description="An app sees the agents its workspace offers, so only apps with these workspaces' keys may run it."
      actionSlot={agent.workspaces.length > 0 ? add : undefined}
      contentSlot={
        <>
          {agent.workspaces.length === 0 ? (
            <EmptyState compact title="No workspace offers it yet, so no app can run it." actionSlot={add} />
          ) : (
            <List
              label="Workspaces"
              contentSlot={agent.workspaces.map((entry) => {
                const name = entry.workspace?.name ?? 'A deleted workspace';
                return (
                  <ListItem
                    key={entry.id}
                    title={name}
                    linkSlot={
                      entry.workspace === null ? undefined : (
                        <Link to="/workspaces/$workspaceId" params={{ workspaceId: entry.workspace.id }} />
                      )
                    }
                    actionSlot={
                      <ConfirmButton
                        size="sm"
                        title={`Stop offering ${displayName} in ${name}?`}
                        description="Apps with that workspace's keys are refused it from their next request. The agent itself is kept."
                        confirmLabel="Remove"
                        onConfirm={() => remove.mutate(entry.id)}
                        content="Remove"
                      />
                    }
                  />
                );
              })}
            />
          )}
          {isAdding ? (
            <AgentWorkspaceDialog
              open
              onOpenChange={setIsAdding}
              agentId={agent.id}
              agentName={displayName}
              choices={available}
            />
          ) : null}
        </>
      }
    />
  );
}
