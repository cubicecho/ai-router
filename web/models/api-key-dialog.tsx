import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ProviderFieldsFragment, SetProviderApiKeyDocument } from '@/__generated__/graphql';
import { PasswordField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';

/** What the key dialog is given. */
export interface ApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderFieldsFragment;
}

/** Sets or clears a provider's key. The key is never shown again: only whether one is set. */
export function ApiKeyDialog({ open, onOpenChange, provider }: ApiKeyDialogProps) {
  const queryClient = useQueryClient();
  const setKey = useMutation({
    mutationFn: (apiKey: string | null) => request(SetProviderApiKeyDocument, { id: provider.id, apiKey }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['providers'] });
      onOpenChange(false);
    },
  });
  const form = useAppForm({
    defaultValues: { apiKey: '' },
    onSubmit: ({ value }) => setKey.mutateAsync(value.apiKey.trim()),
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`${provider.name}'s key`}
      description="Sent as Authorization: Bearer with every call. Once saved it is never shown again."
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <FormElement onSubmit={() => form.handleSubmit()} className={className}>
            {parts}
          </FormElement>
        </form.AppForm>
      )}
      contentSlot={
        <PasswordField
          form={form}
          name="apiKey"
          label="API key"
          autoComplete="off"
          required
          validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Paste the key.' : undefined) }}
        />
      }
      footerActionsSlot={(close) => (
        <>
          {provider.apiKeySet ? (
            <Button
              variant="destructive-outline"
              loading={setKey.isPending && setKey.variables === null}
              onClick={() => setKey.mutate(null)}
              content="Clear key"
            />
          ) : null}
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton content="Save key" />
        </>
      )}
    />
  );
}
