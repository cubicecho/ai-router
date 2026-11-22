import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SetWorkspaceAgentServerEnabledDocument, type WorkspaceAgentsQuery } from '@/__generated__/graphql';
import { DialogLayout } from '@/components/dialog-layout';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { RowMeta, rowNameFact } from '@/components/row-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { request } from '@/lib/gql';
import { BUILTIN, transportOf } from '@/tools/shapes';

/** A server the workspace has, as the workspace's agents query reads it. */
export type WorkspaceServerChoice = NonNullable<WorkspaceAgentsQuery['workspaceServers'][number]['server']>;

/** What the dialog is given. */
export interface AgentServersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** The workspace's entry for the agent. */
  workspaceAgentId: string;
  /** The agent's name, for the title. */
  agentName: string;
  /** The workspace's servers. */
  servers: readonly WorkspaceServerChoice[];
  /** The ids of those turned off for the agent. */
  disabled: ReadonlySet<string>;
}

/**
 * Turns the workspace's servers on or off for one agent there, each as it is switched. Every agent reaches every server
 * of its workspace unless it is turned off for it.
 */
export function AgentServersDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceAgentId,
  agentName,
  servers,
  disabled,
}: AgentServersDialogProps) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: ({ serverId, enabled }: { serverId: string; enabled: boolean }) =>
      request(SetWorkspaceAgentServerEnabledDocument, { workspaceAgentId, serverId, enabled }),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'agents'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`MCP servers for ${agentName}`}
      description="Its runs in this workspace use tools from every server that is on. A change takes effect from the next request. The admin server's tools also need roles, set on the MCP tab."
      contentSlot={
        servers.length === 0 ? (
          <EmptyState compact title="This workspace has no MCP servers yet. Add them on its MCP tab." />
        ) : (
          <List
            label="MCP servers"
            contentSlot={servers.map((server) => {
              const name = server.displayName ?? server.name;
              const isOn = disabled.has(server.id) === false;
              const isBuiltin = transportOf(server.transport).type === BUILTIN;
              return (
                <ListItem
                  key={server.id}
                  title={name}
                  description={isOn ? 'On' : 'Off for this agent'}
                  meta={
                    <RowMeta
                      facts={[rowNameFact(server.displayName, server.name)]}
                      badgesSlot={
                        <>
                          {isBuiltin ? <Badge variant="secondary">Built in</Badge> : null}
                          {server.enabled ? null : <Badge variant="warning-soft">Takes no calls</Badge>}
                        </>
                      }
                    />
                  }
                  actionSlot={
                    <Switch
                      checked={isOn}
                      accessibilityLabel={`${name} for ${agentName}`}
                      disabled={toggle.isPending}
                      onCheckedChange={(enabled) => toggle.mutate({ serverId: server.id, enabled })}
                    />
                  }
                />
              );
            })}
          />
        )
      }
      footerActionsSlot={(close) => <Button variant="outline" onClick={close} content="Done" />}
    />
  );
}
