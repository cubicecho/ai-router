import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CreateWorkerDocument } from '@/__generated__/graphql';
import { InputField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';
import { NAME_HINT } from '@/models/names';
import { workerNameError } from './shapes';
import { WorkerKeyDialog } from './worker-key-dialog';

/** What the worker dialog is given. */
export interface WorkerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** What a new worker made in this dialog left to show: its name and its key, which exists only here. */
interface Made {
  name: string;
  secret: string;
}

/** Adds a remote worker, then shows its key once. */
export function WorkerDialog({ open, onOpenChange }: WorkerDialogProps) {
  const queryClient = useQueryClient();
  // The key exists in this answer and nowhere else, so it lives only as long as the dialog.
  const [made, setMade] = useState<Made | null>(null);
  const create = useMutation({
    mutationFn: (name: string) => request(CreateWorkerDocument, { name }),
    onSuccess: ({ createWorker }) => {
      setMade({ name: createWorker.worker.name, secret: createWorker.secret });
      void queryClient.invalidateQueries({ queryKey: ['workers'] });
    },
  });
  const form = useAppForm({
    defaultValues: { name: '' },
    onSubmit: ({ value }) => create.mutateAsync(value.name.trim()).catch(() => undefined),
  });
  const close = (next: boolean) => {
    if (next === false) {
      setMade(null);
      form.reset();
    }
    onOpenChange(next);
  };

  if (made !== null) {
    return <WorkerKeyDialog open={open} onOpenChange={close} workerName={made.name} secret={made.secret} />;
  }

  return (
    <DialogLayout
      open={open}
      onOpenChange={close}
      title="New worker"
      description="A machine that runs agent loops away from the router. No workspace runs on it until one is set to."
      hasUnsavedChanges={() => form.state.isDefaultValue === false}
      wrapperSlot={(parts, { className }) => (
        <form.AppForm>
          <FormElement onSubmit={() => form.handleSubmit()} className={className}>
            {parts}
          </FormElement>
        </form.AppForm>
      )}
      contentSlot={
        <InputField
          form={form}
          name="name"
          label="Name"
          description={`${NAME_HINT} Such as the machine's name.`}
          required
          validators={{ onChange: ({ value }) => workerNameError(value) }}
        />
      }
      footerActionsSlot={(dismiss) => (
        <>
          <Button variant="outline" onClick={dismiss} content="Cancel" />
          <form.SubmitButton content="Create worker" />
        </>
      )}
    />
  );
}
