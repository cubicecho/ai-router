import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type AgentWorkspaceChoicesQuery, CreateWorkspaceAgentDocument } from '@/__generated__/graphql';
import { SelectField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';

/** How many workspaces the picker lists before it offers a search box. */
const SEARCHABLE_FROM = 8;

/** A workspace the agent could be offered in. */
export type WorkspaceChoice = AgentWorkspaceChoicesQuery['workspaces'][number];

/** What the dialog is given. */
export interface AgentWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  /** What the agent is called, for the title. */
  agentName: string;
  /** The workspaces not offering it yet. */
  choices: readonly WorkspaceChoice[];
}

/** Offers an agent in one more workspace, so the apps calling with that workspace's keys may run it. */
export function AgentWorkspaceDialog({ open, onOpenChange, agentId, agentName, choices }: AgentWorkspaceDialogProps) {
  const queryClient = useQueryClient();
  const add = useMutation({
    mutationFn: (workspaceId: string) => request(CreateWorkspaceAgentDocument, { workspaceId, agentId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      onOpenChange(false);
    },
  });
  const form = useAppForm({
    defaultValues: { workspaceId: '' },
    onSubmit: ({ value }) => add.mutateAsync(value.workspaceId).catch(() => undefined),
  });
  const options = choices.map((workspace) => ({ value: workspace.id, label: workspace.name, meta: workspace.slug }));

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`Offer ${agentName} in a workspace`}
      description="Apps with that workspace's keys may run it from their next request."
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
          name="workspaceId"
          label="Workspace"
          placeholder={options.length === 0 ? 'Every workspace offers it already' : 'Choose a workspace'}
          options={options}
          searchable={options.length > SEARCHABLE_FROM}
          required
          validators={{ onChange: ({ value }) => (value === '' ? 'Choose a workspace.' : undefined) }}
        />
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton content="Offer it" />
        </>
      )}
    />
  );
}
