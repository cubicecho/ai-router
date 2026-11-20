import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CreateWorkspaceKeyDocument } from '@/__generated__/graphql';
import { InputField, NumberField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Code, CodeBlock } from '@/components/ui/code';
import { CopyButton } from '@/components/ui/copy-button';
import { FormElement } from '@/components/ui/form-element';
import { KeyRound } from '@/components/ui/icons';
import { request } from '@/lib/gql';

/** What the key dialog is given. */
export interface KeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
}

/** Makes a key for one of a workspace's apps, then shows it once. */
export function KeyDialog({ open, onOpenChange, workspaceId }: KeyDialogProps) {
  const queryClient = useQueryClient();
  // The key exists in this answer and nowhere else, so it lives only as long as the dialog.
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (values: { name: string; expiresInDays: number | null }) =>
      request(CreateWorkspaceKeyDocument, { workspaceId, ...values }),
    onSuccess: ({ createWorkspaceKey }) => {
      setSecret(createWorkspaceKey.secret);
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
  const form = useAppForm({
    defaultValues: { name: '', expiresInDays: null as number | null },
    onSubmit: ({ value }) => create.mutateAsync({ name: value.name.trim(), expiresInDays: value.expiresInDays }),
  });
  const close = (next: boolean) => {
    if (next === false) {
      setSecret(null);
      form.reset();
    }
    onOpenChange(next);
  };

  if (secret !== null) {
    return (
      <DialogLayout
        open={open}
        onOpenChange={close}
        iconSlot={<KeyRound />}
        title="Your new key"
        contentSlot={
          <>
            <Alert
              variant="warning"
              title="Copy it now"
              description="This is the only time the key is shown. The router keeps only a hash of it."
            />
            <CodeBlock content={secret} wrap actionSlot={<CopyButton value={secret} label="Copy key" />} />
            <p className="text-foreground/60 text-sm">
              Apps send it as <Code>Authorization: Bearer</Code> or <Code>x-api-key</Code>.
            </p>
          </>
        }
        footerActionsSlot={(dismiss) => <Button variant="default" onClick={dismiss} content="Done" />}
      />
    );
  }

  return (
    <DialogLayout
      open={open}
      onOpenChange={close}
      title="New key"
      description="One key for each app or device, so each can be revoked on its own."
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
            name="name"
            label="Name"
            description="What the app is, such as phone or desktop."
            required
            validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Give the key a name.' : undefined) }}
          />
          <NumberField
            form={form}
            name="expiresInDays"
            label="Expires after (days)"
            description="Leave it empty for a key that never expires."
            integer
            min={1}
          />
        </>
      }
      footerActionsSlot={(dismiss) => (
        <>
          <Button variant="outline" onClick={dismiss} content="Cancel" />
          <form.SubmitButton content="Create key" />
        </>
      )}
    />
  );
}
