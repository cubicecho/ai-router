import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ServerFieldsFragment, SetServerLoginClientDocument } from '@/__generated__/graphql';
import { InputField, PasswordField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';

/** What the login client dialog is given. */
export interface LoginClientDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  serverName: string;
  login: NonNullable<ServerFieldsFragment['login']>;
}

/** What the client is sent as: null removes it. */
type ClientInput = { clientId: string; clientSecret?: string | null; scope: string | null } | null;

/**
 * Sets the client a remote server's login knows the router by, for a login that only knows clients
 * it was told about. The secret is never shown again: only whether one is kept.
 */
export function LoginClientDialog({ open, onOpenChange, serverId, serverName, login }: LoginClientDialogProps) {
  const queryClient = useQueryClient();
  const setClient = useMutation({
    mutationFn: (client: ClientInput) => request(SetServerLoginClientDocument, { serverId, client }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
      onOpenChange(false);
    },
  });
  const form = useAppForm({
    defaultValues: { clientId: login.clientId ?? '', clientSecret: '', scope: login.scope ?? '' },
    onSubmit: ({ value }) => {
      const secret = value.clientSecret.trim();
      const scope = value.scope.trim();
      return setClient.mutateAsync({
        clientId: value.clientId.trim(),
        // Left out keeps a kept secret while the client id is the same one.
        ...(secret === '' ? {} : { clientSecret: secret }),
        scope: scope === '' ? null : scope,
      });
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`${serverName}'s login client`}
      description="For a login that does not let the router register itself: the client id it gave you, and its secret if it has one. The secret is never shown again."
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
            name="clientId"
            label="Client id"
            autoComplete="off"
            required
            validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Enter the client id.' : undefined) }}
          />
          <PasswordField
            form={form}
            name="clientSecret"
            label="Client secret"
            autoComplete="off"
            description={
              login.hasClientSecret
                ? 'Left blank, the kept secret stays while the client id is the same.'
                : 'Only for a login that gave you one.'
            }
          />
          <InputField
            form={form}
            name="scope"
            label="Scope"
            description="What to ask for when the server does not say, such as read write."
          />
        </>
      }
      footerActionsSlot={(close) => (
        <>
          {login.clientRegistered ? (
            <Button
              variant="destructive-outline"
              loading={setClient.isPending && setClient.variables === null}
              onClick={() => setClient.mutate(null)}
              content="Remove client"
            />
          ) : null}
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton content="Save client" />
        </>
      )}
    />
  );
}
