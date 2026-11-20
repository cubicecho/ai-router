import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SetWorkspaceAgentServersDocument, type WorkspaceAgentsQuery } from '@/__generated__/graphql';
import { ComboboxField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';
import { BUILTIN, transportOf } from '@/tools/shapes';

/** A server the dialog offers, as the workspace's agents query reads it. */
type ServerChoice = WorkspaceAgentsQuery['serverChoices'][number];

/** What the dialog is given. */
export interface AgentServersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** The workspace's entry for the agent. */
  workspaceAgentId: string;
  /** The agent's name, for the title. */
  agentName: string;
  /** The servers granted now, by id. */
  granted: readonly string[];
  /** Every server on the router. */
  choices: readonly ServerChoice[];
}

/**
 * Says how a server is listed in the picker.
 *
 * @param server - The server.
 * @returns Its label, with what sets it apart: the admin server, or one that is off.
 */
function labelOf(server: ServerChoice): string {
  const name = server.displayName ?? server.name;
  if (transportOf(server.transport).type === BUILTIN) {
    return `${name} (built in)`;
  }
  return server.enabled ? name : `${name} (off)`;
}

/** Chooses the MCP servers an agent may use in one workspace: its runs there reach exactly these. */
export function AgentServersDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceAgentId,
  agentName,
  granted,
  choices,
}: AgentServersDialogProps) {
  const queryClient = useQueryClient();
  const save = useMutation({
    mutationFn: (serverIds: string[]) => request(SetWorkspaceAgentServersDocument, { workspaceAgentId, serverIds }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'agents'] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      onOpenChange(false);
    },
  });
  const form = useAppForm({
    defaultValues: { serverIds: [...granted] },
    onSubmit: ({ value }) => save.mutateAsync(value.serverIds).catch(() => undefined),
  });
  const options = choices.map((server) => ({ value: server.id, label: labelOf(server), meta: server.name }));

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`MCP servers for ${agentName}`}
      description="Its runs in this workspace use tools from exactly these, and from none when none are chosen. The admin server's tools also need roles, set on the MCP tab."
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <FormElement onSubmit={() => form.handleSubmit()} className={className}>
            {parts}
          </FormElement>
        </form.AppForm>
      )}
      contentSlot={
        <ComboboxField
          form={form}
          name="serverIds"
          label="MCP servers"
          multiple
          options={options}
          placeholder="None: no MCP tools here"
        />
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton createLabel="Save" />
        </>
      )}
    />
  );
}
