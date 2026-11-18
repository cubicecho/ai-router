import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CreateWorkspaceDocument,
  UpdateWorkspaceDocument,
  type WorkspaceFieldsFragment,
} from '@/__generated__/graphql';
import { InputField, TextareaField, useAppForm } from '@/components/app-form';
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
}

/** Makes or edits a workspace: its slug, name and description. */
export function WorkspaceDialog({ open, onOpenChange, workspace, onSaved }: WorkspaceDialogProps) {
  const queryClient = useQueryClient();
  const isEdit = workspace !== null;
  const save = useMutation({
    mutationFn: async (values: { slug: string; name: string; description: string }) => {
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
  const form = useAppForm({
    defaultValues: {
      slug: workspace?.slug ?? '',
      name: workspace?.name ?? '',
      description: workspace?.description ?? '',
    },
    onSubmit: ({ value }) =>
      save.mutateAsync({ slug: value.slug.trim(), name: value.name.trim(), description: value.description }),
  });

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
        <div className="grid gap-4">
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
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton
            variant={isEdit ? 'positive' : 'info'}
            requireChanges={isEdit}
            content={isEdit ? 'Save changes' : 'Create workspace'}
          />
        </>
      )}
    />
  );
}
