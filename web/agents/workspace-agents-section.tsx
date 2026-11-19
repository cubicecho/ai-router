import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { DeleteWorkspaceAgentDocument, WorkspaceAgentsDocument } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Bot, Plus } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { displayNameOf } from './shapes';
import { WorkspaceAgentDialog } from './workspace-agent-dialog';

/** What the section is given. */
export interface WorkspaceAgentsSectionProps {
  workspaceId: string;
}

/**
 * The agents a workspace offers: the only ones an app calling with its keys may list and run. Untitled: its tab names
 * it.
 */
export function WorkspaceAgentsSection({ workspaceId }: WorkspaceAgentsSectionProps) {
  const queryClient = useQueryClient();
  const [isAdding, setIsAdding] = useState(false);
  const entries = useQuery({
    queryKey: ['workspaces', workspaceId, 'agents'],
    queryFn: () => request(WorkspaceAgentsDocument, { workspaceId }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => request(DeleteWorkspaceAgentDocument, { id }),
    onSuccess: () => {
      // The whole prefix: the workspaces list counts each one's agents too.
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });
  const rows = entries.data?.workspaceAgents ?? [];
  const taken = new Set(rows.map((row) => row.agentId));
  const choices = (entries.data?.agents ?? []).filter((agent) => taken.has(agent.id) === false);
  const add = (
    <Button
      variant="positive"
      size="sm"
      iconSlot={<Plus />}
      onClick={() => setIsAdding(true)}
      disabled={entries.isPending || choices.length === 0}
      hint={entries.data !== undefined && choices.length === 0 ? 'Every agent is offered here already.' : undefined}
      content="Add agent"
    />
  );

  return (
    <Section
      description="An app with this workspace's key sees only these agents."
      actionSlot={rows.length > 0 ? add : undefined}
      contentSlot={
        <>
          <LoadState
            query={entries}
            what="its agents"
            count={rows.length}
            emptySlot={
              <EmptyState
                iconSlot={<Bot />}
                title="No agents yet"
                description={
                  choices.length === 0
                    ? 'Add one on the Agents page, then offer it here.'
                    : 'Apps here have nothing to run until an agent is offered.'
                }
                actionSlot={choices.length === 0 ? undefined : add}
              />
            }
          />
          <List
            label="Agents"
            contentSlot={rows.map((entry) => {
              const name = entry.agent === null ? 'A deleted agent' : displayNameOf(entry.agent);
              return (
                <ListItem
                  key={entry.id}
                  title={name}
                  description={
                    entry.agent === null || entry.agent.name === name ? undefined : (
                      <span className="font-mono text-foreground/60 text-xs">{entry.agent.name}</span>
                    )
                  }
                  meta={
                    entry.agent?.liveRevisionId === null ? <Badge variant="warning-soft">Can't run</Badge> : undefined
                  }
                  linkSlot={
                    entry.agent === null ? undefined : (
                      <Link to="/agents/$agentId" params={{ agentId: entry.agentId }} />
                    )
                  }
                  actionSlot={
                    <ConfirmButton
                      size="sm"
                      title={`Stop offering ${name} here?`}
                      description="Apps with this workspace's keys are refused it from their next request. The agent itself is kept."
                      confirmLabel="Remove"
                      onConfirm={() => remove.mutate(entry.id)}
                      content="Remove"
                    />
                  }
                />
              );
            })}
          />
          {isAdding ? (
            <WorkspaceAgentDialog open onOpenChange={setIsAdding} workspaceId={workspaceId} choices={choices} />
          ) : null}
        </>
      }
    />
  );
}
