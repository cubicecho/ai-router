import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CreateProviderDocument, type ProviderFieldsFragment, UpdateProviderDocument } from '@/__generated__/graphql';
import { InputField, SwitchField, TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';
import { NAME_HINT, NAME_PATTERN } from '@/models/names';
import { headersOf, headersToText, textToHeaders } from './headers';

/** What the provider dialog is given. */
export interface ProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The provider to edit, or null to add one. */
  provider: ProviderFieldsFragment | null;
  /** Called with the provider once it is saved. */
  onSaved?: (provider: ProviderFieldsFragment) => void;
}

/** Adds or edits a provider: its name, address, headers and whether it takes calls. */
export function ProviderDialog({ open, onOpenChange, provider, onSaved }: ProviderDialogProps) {
  const queryClient = useQueryClient();
  const isEdit = provider !== null;
  const save = useMutation({
    mutationFn: async (values: {
      name: string;
      displayName: string | null;
      baseUrl: string;
      description: string;
      enabled: boolean;
      headers: Record<string, string>;
    }) => {
      if (provider === null) {
        return (await request(CreateProviderDocument, { values })).createProvider;
      }
      const { updateProvider } = await request(UpdateProviderDocument, { id: provider.id, set: values });
      if (updateProvider === null) {
        throw new Error('That provider is gone. Someone may have deleted it.');
      }
      return updateProvider;
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      onOpenChange(false);
      onSaved?.(saved);
    },
  });
  const form = useAppForm({
    defaultValues: {
      name: provider?.name ?? '',
      displayName: provider?.displayName ?? '',
      baseUrl: provider?.baseUrl ?? '',
      description: provider?.description ?? '',
      enabled: provider?.enabled ?? true,
      headers: provider === null ? '' : headersToText(headersOf(provider.headers)),
    },
    onSubmit: ({ value }) => {
      const parsed = textToHeaders(value.headers);
      return save.mutateAsync({
        name: value.name.trim(),
        displayName: value.displayName.trim() === '' ? null : value.displayName.trim(),
        baseUrl: value.baseUrl.trim(),
        description: value.description,
        enabled: value.enabled,
        headers: parsed.headers ?? {},
      });
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `Edit ${provider.name}` : 'New provider'}
      description="A model server the router's agents call: anything that speaks OpenAI's API."
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
                ? `${NAME_HINT} Agents name its models as <name>/<model>, so renaming breaks those that use the old name.`
                : `${NAME_HINT} Agents name its models as <name>/<model>.`
            }
            required
            validators={{
              onChange: ({ value }) => (NAME_PATTERN.test(value.trim()) ? undefined : NAME_HINT),
            }}
          />
          <InputField form={form} name="displayName" label="Display name" />
          <InputField
            form={form}
            name="baseUrl"
            label="Base URL"
            description="Its OpenAI address, such as http://ollama:11434/v1."
            required
            validators={{
              onChange: ({ value }) => (URL.canParse(value.trim()) ? undefined : 'Enter an http or https URL.'),
            }}
          />
          <TextareaField
            form={form}
            name="headers"
            label="Extra headers"
            description="One per line, as Name: value. They are shown here, so put a key in the API key instead."
            rows={3}
            validators={{ onChange: ({ value }) => textToHeaders(value).error ?? undefined }}
          />
          <TextareaField form={form} name="description" label="Description" rows={2} />
          <SwitchField
            form={form}
            name="enabled"
            label="Takes calls"
            description="Off, agents and pools pass it over."
          />
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton
            variant={isEdit ? 'positive' : 'info'}
            requireChanges={isEdit}
            content={isEdit ? 'Save changes' : 'Add provider'}
          />
        </>
      )}
    />
  );
}
