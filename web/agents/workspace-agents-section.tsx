import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { DeleteWorkspaceAgentDocument, WorkspaceAgentsDocument } from '@/__generated__/graphql';
import { CardLayout } from '@/components/card-layout';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { RowMeta, rowNameFact } from '@/components/row-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plug, Plus } from '@/components/ui/icons';
import { joinStats } from '@/lib/format';
import { request } from '@/lib/gql';
import { AgentServersDialog } from './agent-servers-dialog';
import { displayNameOf } from './shapes';
import { WorkspaceAgentDialog } from './workspace-agent-dialog';

/** What the section is given. */
export interface WorkspaceAgentsSectionProps {
  workspaceId: string;
}

/**
 * The agents a workspace offers: the only ones an app calling with its keys may list and run, each with the
 * workspace's MCP servers it reaches here, every one unless turned off for it. Untitled: its tab names it.
 */
export function WorkspaceAgentsSection({ workspaceId }: WorkspaceAgentsSectionProps) {
  const queryClient = useQueryClient();
  const [isAdding, setIsAdding] = useState(false);
  // The entry whose servers are being chosen, by id.
  const [choosingFor, setChoosingFor] = useState<string | null>(null);
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
  const choosingEntry = rows.find((row) => row.id === choosingFor);
  const workspaceServers = (entries.data?.workspaceServers ?? [])
    .flatMap((row) => (row.server === null || row.server === undefined ? [] : [row.server]))
    .sort((a, b) => a.name.localeCompare(b.name));
  /** The ids of the workspace's servers turned off for one entry's agent. */
  const disabledFor = (entryId: string): Set<string> =>
    new Set(
      (entries.data?.disabledServers ?? []).flatMap((row) => (row.workspaceAgentId === entryId ? [row.serverId] : [])),
    );
  /** What one entry's agent reaches here, by name. */
  const reachedBy = (entryId: string): string[] => {
    const disabled = disabledFor(entryId);
    return workspaceServers.flatMap((server) => (disabled.has(server.id) ? [] : [server.displayName ?? server.name]));
  };
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
    <CardLayout
      level={2}
      description="An app with this workspace's key sees only these agents."
      actionSlot={rows.length > 0 ? add : undefined}
      contentSlot={
        <>
          <LoadState
            compact
            query={entries}
            what="its agents"
            count={rows.length}
            emptySlot={
              <EmptyState
                compact
                title={
                  choices.length === 0
                    ? 'No agents yet. Add one on the Agents page, then offer it here.'
                    : 'No agents yet, so apps here have nothing to run.'
                }
                actionSlot={choices.length === 0 ? undefined : add}
              />
            }
          />
          <List
            label="Agents"
            contentSlot={rows.map((entry) => {
              const name = entry.agent === null ? 'A deleted agent' : displayNameOf(entry.agent);
              const reached = reachedBy(entry.id);
              return (
                <ListItem
                  key={entry.id}
                  title={name}
                  description={reached.length === 0 ? 'No MCP servers' : joinStats(...reached)}
                  meta={
                    <RowMeta
                      facts={[entry.agent === null ? null : rowNameFact(name, entry.agent.name)]}
                      badgesSlot={
                        entry.agent?.liveRevisionId === null ? <Badge variant="warning-soft">Can't run</Badge> : null
                      }
                    />
                  }
                  linkSlot={
                    entry.agent === null ? undefined : (
                      <Link to="/agents/$agentId" params={{ agentId: entry.agentId }} />
                    )
                  }
                  actionSlot={
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        iconSlot={<Plug />}
                        onClick={() => setChoosingFor(entry.id)}
                        content="MCP servers"
                      />
                      <ConfirmButton
                        size="sm"
                        title={`Stop offering ${name} here?`}
                        description="Apps with this workspace's keys are refused it from their next request. The agent itself is kept."
                        confirmLabel="Remove"
                        onConfirm={() => remove.mutate(entry.id)}
                        content="Remove"
                      />
                    </>
                  }
                />
              );
            })}
          />
          {choosingEntry === undefined ? null : (
            <AgentServersDialog
              key={choosingEntry.id}
              open
              onOpenChange={(open) => (open ? undefined : setChoosingFor(null))}
              workspaceId={workspaceId}
              workspaceAgentId={choosingEntry.id}
              agentName={choosingEntry.agent === null ? 'a deleted agent' : displayNameOf(choosingEntry.agent)}
              servers={workspaceServers}
              disabled={disabledFor(choosingEntry.id)}
            />
          )}
          {isAdding ? (
            <WorkspaceAgentDialog open onOpenChange={setIsAdding} workspaceId={workspaceId} choices={choices} />
          ) : null}
        </>
      }
    />
  );
}
