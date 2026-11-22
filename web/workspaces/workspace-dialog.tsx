import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CopyWorkspaceDocument,
  CreateWorkspaceDocument,
  UpdateWorkspaceDocument,
  type WorkspaceFieldsFragment,
} from '@/__generated__/graphql';
import { InputField, SelectField, TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';
import { NAME_HINT, NAME_PATTERN } from '@/models/names';

/** What the workspace dialog is given. */
export interface WorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The workspace to edit, or null to make a new one. */
  workspace: WorkspaceFieldsFragment | null;
  /** Called with the workspace once it is saved. */
  onSaved?: (workspace: WorkspaceFieldsFragment) => void;
  /** The workspaces a new one may start as a copy of. None offers no copy. */
  copyChoices?: readonly WorkspaceFieldsFragment[];
}

/** What a workspace is saved with. */
interface WorkspaceValues {
  slug: string;
  name: string;
  description: string;
  /** The workspace a new one copies its agents and servers from, or null to start empty. */
  copyFrom: string | null;
}

/** Makes or edits a workspace: its slug, name and description. A new one may start as a copy of another. */
export function WorkspaceDialog({ open, onOpenChange, workspace, onSaved, copyChoices = [] }: WorkspaceDialogProps) {
  const queryClient = useQueryClient();
  const isEdit = workspace !== null;
  const save = useMutation({
    mutationFn: async ({ copyFrom, ...values }: WorkspaceValues) => {
      if (workspace === null && copyFrom !== null) {
        return (await request(CopyWorkspaceDocument, { fromWorkspaceId: copyFrom, ...values })).copyWorkspace;
      }
      if (workspace === null) {
        return (await request(CreateWorkspaceDocument, values)).createWorkspace;
      }
      const { updateWorkspace } = await request(UpdateWorkspaceDocument, { id: workspace.id, ...values });
      if (updateWorkspace === null) {
        throw new Error('That workspace is gone. Someone may have deleted it.');
      }
      return updateWorkspace;
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      onOpenChange(false);
      onSaved?.(saved);
    },
  });
  const defaultValues: WorkspaceValues = {
    slug: workspace?.slug ?? '',
    name: workspace?.name ?? '',
    description: workspace?.description ?? '',
    copyFrom: null,
  };
  const form = useAppForm({
    defaultValues,
    onSubmit: ({ value }) =>
      save.mutateAsync({
        slug: value.slug.trim(),
        name: value.name.trim(),
        description: value.description,
        copyFrom: value.copyFrom,
      }),
  });
  const canCopy = isEdit === false && copyChoices.length > 0;

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? 'Edit workspace' : 'New workspace'}
      description="A workspace is what one app sees. Its keys say which app is calling."
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <FormElement onSubmit={() => form.handleSubmit()} className={className}>
            {parts}
          </FormElement>
        </form.AppForm>
      )}
      contentSlot={
        <>
          <InputField
            form={form}
            name="slug"
            label="Slug"
            description={`${NAME_HINT} Such as min-agent.`}
            required
            validators={{
              onChange: ({ value }) => (NAME_PATTERN.test(value.trim()) ? undefined : NAME_HINT),
            }}
          />
          <InputField
            form={form}
            name="name"
            label="Name"
            required
            validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Give it a name.' : undefined) }}
          />
          <TextareaField form={form} name="description" label="Description" rows={3} />
          {canCopy ? (
            <SelectField
              form={form}
              name="copyFrom"
              label="Copy agents and MCP servers from"
              description="Its agents, its servers with their settings, and what is turned off for each agent. Never its keys or secrets: make keys for the new workspace, and set its secret overrides again."
              options={copyChoices.map((choice) => ({ value: choice.id, label: choice.name }))}
              clearable
              emptyLabel="Nothing: start empty"
            />
          ) : null}
        </>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton requireChanges={isEdit} content={isEdit ? 'Save changes' : 'Create workspace'} />
        </>
      )}
    />
  );
}
