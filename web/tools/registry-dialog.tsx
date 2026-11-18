import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreateRegistryDocument, type RegistryFieldsFragment, UpdateRegistryDocument } from '@/__generated__/graphql';
import { InputField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';
import { NAME_HINT, NAME_PATTERN } from '@/models/names';

/** What the registry dialog is given. */
export interface RegistryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The registry to edit, or null to add one. */
  registry: RegistryFieldsFragment | null;
}

/** Adds or edits a registry: its name and the address of its catalogue. */
export function RegistryDialog({ open, onOpenChange, registry }: RegistryDialogProps) {
  const queryClient = useQueryClient();
  const isEdit = registry !== null;
  const save = useMutation({
    mutationFn: async (values: { name: string; url: string }) => {
      if (registry === null) {
        return (await request(CreateRegistryDocument, { values })).createRegistry;
      }
      const { updateRegistry } = await request(UpdateRegistryDocument, { id: registry.id, set: values });
      if (updateRegistry === null) {
        throw new Error('That registry is gone. Someone may have deleted it.');
      }
      return updateRegistry;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['registries'] });
      onOpenChange(false);
    },
  });
  const form = useAppForm({
    defaultValues: { name: registry?.name ?? '', url: registry?.url ?? '' },
    onSubmit: ({ value }) => save.mutateAsync({ name: value.name.trim(), url: value.url.trim() }),
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${registry.name}` : 'New registry'}
      description="A catalogue of MCP servers to install from, such as the official one at registry.modelcontextprotocol.io."
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
            name="name"
            label="Name"
            description={
              isEdit
                ? `${NAME_HINT} Servers installed from it name it, so they keep the old name.`
                : `${NAME_HINT} Servers installed from it say where they came from by it.`
            }
            required
            validators={{ onChange: ({ value }) => (NAME_PATTERN.test(value.trim()) ? undefined : NAME_HINT) }}
          />
          <InputField
            form={form}
            name="url"
            label="Address"
            description="Its base URL, such as https://registry.modelcontextprotocol.io."
            required
            validators={{
              onChange: ({ value }) => (URL.canParse(value.trim()) ? undefined : 'Enter an http or https URL.'),
            }}
          />
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton requireChanges={isEdit} content={isEdit ? 'Save changes' : 'Add registry'} />
        </>
      )}
    />
  );
}
