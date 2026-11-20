import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SetServerSecretDocument } from '@/__generated__/graphql';
import { InputField, PasswordField, SelectField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';
import { HEADER_NAME_PATTERN } from './shapes';

/** What a secret is: an env var a program gets, or a header sent to an address. */
export type SecretKind = 'env' | 'header';

/** The kinds, as people read them. */
const KINDS: { value: SecretKind; label: string }[] = [
  { value: 'env', label: 'Env var' },
  { value: 'header', label: 'Header' },
];

/** An env var's name, as a shell takes it. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The secret a dialog opens on: a name already set or described, or a new one of a kind. */
export interface SecretTarget {
  kind: SecretKind;
  /** Empty for a new one, typed in the dialog. */
  name: string;
  /** Whether a value is set now, so the dialog offers to clear it. */
  isSet: boolean;
}

/** What the secret dialog is given. */
export interface SecretDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverId: string;
  serverName: string;
  /** The workspace whose override this is, or null for the server's own. */
  workspaceId: string | null;
  target: SecretTarget;
}

/** Sets or clears one of a server's secrets. The value is never shown again: only that one is set. */
export function SecretDialog({ open, onOpenChange, serverId, serverName, workspaceId, target }: SecretDialogProps) {
  const queryClient = useQueryClient();
  const isNew = target.name === '';
  const setSecret = useMutation({
    mutationFn: (values: { kind: SecretKind; name: string; value: string | null }) =>
      request(SetServerSecretDocument, { serverId, workspaceId, ...values }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      onOpenChange(false);
    },
  });
  const form = useAppForm({
    defaultValues: { kind: target.kind as string, name: target.name, value: '' },
    onSubmit: ({ value }) =>
      setSecret.mutateAsync({
        kind: value.kind === 'header' ? 'header' : 'env',
        name: value.name.trim(),
        value: value.value === '' ? null : value.value,
      }),
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isNew ? `A secret for ${serverName}` : target.name}
      description={
        workspaceId === null
          ? 'Kept by the router and given to the server, never shown again. A workspace can override it.'
          : "This workspace's own value, used in place of the server's for its agent runs. Never shown again."
      }
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
          {isNew ? (
            <>
              <SelectField form={form} name="kind" label="Kind" options={KINDS} />
              <InputField
                form={form}
                name="name"
                label="Name"
                placeholder="API_KEY"
                required
                validators={{
                  onChangeListenTo: ['kind'],
                  onChange: ({ value, fieldApi }) => {
                    const isEnv = fieldApi.form.getFieldValue('kind') !== 'header';
                    if ((isEnv ? ENV_NAME : HEADER_NAME_PATTERN).test(value.trim())) {
                      return undefined;
                    }
                    return isEnv
                      ? 'Letters, digits and _, not starting with a digit.'
                      : 'A header name, such as Authorization.';
                  },
                }}
              />
            </>
          ) : null}
          <PasswordField
            form={form}
            name="value"
            label="Value"
            autoComplete="off"
            description="Left blank, it clears the value set."
          />
        </>
      }
      footerActionsSlot={(close) => (
        <>
          {target.isSet ? (
            <Button
              variant="destructive-outline"
              loading={setSecret.isPending && setSecret.variables?.value === null}
              onClick={() => setSecret.mutate({ kind: target.kind, name: target.name, value: null })}
              content="Clear"
            />
          ) : null}
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton content="Save secret" />
        </>
      )}
    />
  );
}
