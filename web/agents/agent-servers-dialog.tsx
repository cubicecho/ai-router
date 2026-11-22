import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ServerToolsDocument,
  SetWorkspaceAgentServerEnabledDocument,
  SetWorkspaceAgentToolEnabledDocument,
  type WorkspaceAgentsQuery,
} from '@/__generated__/graphql';
import { CollapsibleRow } from '@/components/collapsible-row';
import { DialogLayout } from '@/components/dialog-layout';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { RowMeta, rowNameFact } from '@/components/row-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { request } from '@/lib/gql';
import { useOpenRows } from '@/lib/use-open-rows';
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
  /** By server id: the tools turned off for the agent, by their own names on the server. */
  disabledTools: ReadonlyMap<string, ReadonlySet<string>>;
}

/** One tool a server row lists. */
interface ToolChoice {
  /** Its own name on the server. */
  name: string;
  title: string | null;
  description: string | null;
  /** Whether it is turned off for the agent. */
  isOff: boolean;
  /** Whether it is turned off and the server no longer offers it. */
  isGone: boolean;
}

/** What one server's row is given. */
interface ServerToolsRowProps {
  workspaceId: string;
  agentName: string;
  server: WorkspaceServerChoice;
  /** Whether the server is on for the agent. */
  isOn: boolean;
  /** The tools turned off for the agent on this server. */
  disabledTools: ReadonlySet<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether a switch is being saved. */
  isSaving: boolean;
  onServerChange: (enabled: boolean) => void;
  onToolChange: (tool: string, enabled: boolean) => void;
}

/**
 * Lists a server's tools for the switches: what it offers, as the workspace's instance lists it, then any tool turned
 * off that it no longer offers.
 *
 * @param listed - What the server offers, or undefined when it hasn't listed.
 * @param disabledTools - The tools turned off for the agent.
 * @returns The tools, those it offers in its order, the gone ones after. Unlisted, only the ones turned off.
 */
function toolChoices(
  listed: readonly { name: string; title?: string | null; description?: string | null }[] | undefined,
  disabledTools: ReadonlySet<string>,
): ToolChoice[] {
  const offered = (listed ?? []).map((tool) => ({
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    isOff: disabledTools.has(tool.name),
    isGone: false,
  }));
  const offeredNames = new Set(offered.map((tool) => tool.name));
  const saved = [...disabledTools]
    .filter((name) => offeredNames.has(name) === false)
    .sort()
    .map((name) => ({ name, title: null, description: null, isOff: true, isGone: listed !== undefined }));
  return [...offered, ...saved];
}

/**
 * Says how many of a server's tools the agent reaches.
 *
 * @param listed - What the server offers, or undefined when it hasn't listed.
 * @param disabledTools - The tools turned off for the agent.
 * @returns "All tools", "n of m tools" once listed, or how many are turned off before.
 */
function toolsSummary(listed: readonly { name: string }[] | undefined, disabledTools: ReadonlySet<string>): string {
  if (listed === undefined) {
    return disabledTools.size === 0 ? 'All tools' : `${disabledTools.size} turned off`;
  }
  const on = listed.filter((tool) => disabledTools.has(tool.name) === false).length;
  return on === listed.length ? 'All tools' : `${on} of ${listed.length} tools`;
}

/**
 * One of the workspace's servers in the dialog: its switch, and, opened, a switch for each of its tools.
 *
 * @param props - The row's server, its switches' state and what they change.
 * @returns The row.
 */
function ServerToolsRow({
  workspaceId,
  agentName,
  server,
  isOn,
  disabledTools,
  open,
  onOpenChange,
  isSaving,
  onServerChange,
  onToolChange,
}: ServerToolsRowProps) {
  const name = server.displayName ?? server.name;
  const isBuiltin = transportOf(server.transport).type === BUILTIN;
  // Asked only once the row is opened, since listing starts the server's instance.
  const tools = useQuery({
    queryKey: ['servers', server.id, 'tools', workspaceId],
    queryFn: () => request(ServerToolsDocument, { id: server.id, workspaceId }),
    enabled: open && server.enabled,
    meta: { quiet: true },
  });
  const listed = tools.data?.serverTools;
  const choices = toolChoices(listed, disabledTools);

  const body = () => (
    <>
      {isOn ? null : (
        <EmptyState
          compact
          title="It is off for this agent, so none of its tools are reached. These choices come back when it is on."
        />
      )}
      {server.enabled ? (
        <LoadState
          compact
          query={tools}
          what="its tools"
          count={choices.length}
          rows={3}
          emptySlot={<EmptyState compact title="It offers no tools." />}
        />
      ) : (
        <EmptyState compact title="It takes no calls, so its tools can't be listed. Its saved choices are below." />
      )}
      <List
        label={`Tools of ${name}`}
        contentSlot={choices.map((tool) => (
          <ListItem
            key={tool.name}
            title={tool.title ?? tool.name}
            description={tool.description ?? undefined}
            meta={
              <RowMeta
                facts={[rowNameFact(tool.title, tool.name)]}
                badgesSlot={tool.isGone ? <Badge variant="info-soft">No longer offered</Badge> : null}
              />
            }
            actionSlot={
              <Switch
                checked={tool.isOff === false}
                accessibilityLabel={`${tool.name} for ${agentName}`}
                disabled={isSaving}
                onCheckedChange={(enabled) => onToolChange(tool.name, enabled)}
              />
            }
          />
        ))}
      />
    </>
  );

  return (
    <CollapsibleRow
      open={open}
      onOpenChange={onOpenChange}
      title={name}
      description={isOn ? toolsSummary(listed, disabledTools) : 'Off for this agent'}
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
          disabled={isSaving}
          onCheckedChange={onServerChange}
        />
      }
      contentSlot={body()}
    />
  );
}

/**
 * Turns the workspace's servers, or single tools of them, on or off for one agent there, each as it is switched.
 * Every agent reaches every tool of every server of its workspace unless it is turned off for it.
 */
export function AgentServersDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceAgentId,
  agentName,
  servers,
  disabled,
  disabledTools,
}: AgentServersDialogProps) {
  const queryClient = useQueryClient();
  const rows = useOpenRows<string>();
  const onSettled = () => {
    void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'agents'] });
    void queryClient.invalidateQueries({ queryKey: ['agents'] });
  };
  const toggleServer = useMutation({
    mutationFn: ({ serverId, enabled }: { serverId: string; enabled: boolean }) =>
      request(SetWorkspaceAgentServerEnabledDocument, { workspaceAgentId, serverId, enabled }),
    onSettled,
  });
  const toggleTool = useMutation({
    mutationFn: ({ serverId, tool, enabled }: { serverId: string; tool: string; enabled: boolean }) =>
      request(SetWorkspaceAgentToolEnabledDocument, { workspaceAgentId, serverId, tool, enabled }),
    onSettled,
  });
  const isSaving = toggleServer.isPending || toggleTool.isPending;
  const noTools: ReadonlySet<string> = new Set();

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`MCP servers for ${agentName}`}
      description="Its runs in this workspace use every tool of every server that is on, but those turned off. Open a server to choose its tools. A change takes effect from the next request. The admin server's tools also need roles, set on the MCP tab."
      contentSlot={
        servers.length === 0 ? (
          <EmptyState compact title="This workspace has no MCP servers yet. Add them on its MCP tab." />
        ) : (
          <List
            label="MCP servers"
            contentSlot={servers.map((server) => (
              <ServerToolsRow
                key={server.id}
                workspaceId={workspaceId}
                agentName={agentName}
                server={server}
                isOn={disabled.has(server.id) === false}
                disabledTools={disabledTools.get(server.id) ?? noTools}
                open={rows.isOpen(server.id)}
                onOpenChange={(next) => rows.setOpen(server.id, next)}
                isSaving={isSaving}
                onServerChange={(enabled) => toggleServer.mutate({ serverId: server.id, enabled })}
                onToolChange={(tool, enabled) => toggleTool.mutate({ serverId: server.id, tool, enabled })}
              />
            ))}
          />
        )
      }
      footerActionsSlot={(close) => <Button variant="outline" onClick={close} content="Done" />}
    />
  );
}
