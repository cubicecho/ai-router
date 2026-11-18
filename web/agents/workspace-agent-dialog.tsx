import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreateWorkspaceAgentDocument, type WorkspaceAgentChoiceFragment } from '@/__generated__/graphql';
import { SelectField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';
import { displayNameOf } from './shapes';

/** How many agents the picker lists before it offers a search box. */
const SEARCHABLE_FROM = 8;

/** What the add dialog is given. */
export interface WorkspaceAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** The agents not offered here yet. */
  choices: readonly WorkspaceAgentChoiceFragment[];
}

/** Offers one more agent to the apps that call with this workspace's keys. */
export function WorkspaceAgentDialog({ open, onOpenChange, workspaceId, choices }: WorkspaceAgentDialogProps) {
  const queryClient = useQueryClient();
  const add = useMutation({
    mutationFn: (agentId: string) => request(CreateWorkspaceAgentDocument, { workspaceId, agentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      onOpenChange(false);
    },
  });
  const form = useAppForm({
    defaultValues: { agentId: '' },
    onSubmit: ({ value }) => add.mutateAsync(value.agentId).catch(() => undefined),
  });
  const options = choices.map((agent) => {
    const name = displayNameOf(agent);
    return { value: agent.id, label: name === agent.name ? name : `${name} (${agent.name})` };
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title="Add an agent"
      description="Apps with this workspace's keys may run it from their next request."
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <FormElement onSubmit={() => form.handleSubmit()} className={className}>
            {parts}
          </FormElement>
        </form.AppForm>
      )}
      contentSlot={
        <SelectField
          form={form}
          name="agentId"
          label="Agent"
          placeholder={options.length === 0 ? 'Every agent is offered here already' : 'Choose an agent'}
          options={options}
          searchable={options.length > SEARCHABLE_FROM}
          required
          validators={{ onChange: ({ value }) => (value === '' ? 'Choose an agent.' : undefined) }}
        />
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton content="Add agent" />
        </>
      )}
    />
  );
}
