import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SetWorkspaceWorkerDocument, WorkersDocument } from '@/__generated__/graphql';
import { SelectField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { useToast } from '@/components/ui/toast';
import { request } from '@/lib/gql';
import { isLocalWorker, LOCAL_WORKER_NAME, localFirst } from '@/workers/shapes';

/** How many workers the picker lists before it offers a search box. */
const SEARCHABLE_FROM = 8;

/** The choice that stands for `local`, which a workspace stores as no worker. Never an id, so never a worker's. */
const LOCAL_CHOICE = LOCAL_WORKER_NAME;

/** What the dialog is given. */
export interface WorkspaceWorkerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** What the workspace is called, for the title and the toast. */
  workspaceName: string;
  /** The worker it runs on now, or null for `local`. */
  workerId: string | null;
}

/** Picks the worker a workspace's runs go to, from its next run. */
export function WorkspaceWorkerDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  workerId,
}: WorkspaceWorkerDialogProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const workers = useQuery({ queryKey: ['workers'], queryFn: () => request(WorkersDocument), enabled: open });
  const save = useMutation({
    // `local` is stored as none, so it is sent as none: one spelling either way.
    mutationFn: (choice: string) =>
      request(SetWorkspaceWorkerDocument, { workspaceId, workerId: choice === LOCAL_CHOICE ? null : choice }),
    onSuccess: ({ setWorkspaceWorker }) => {
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      void queryClient.invalidateQueries({ queryKey: ['workers'] });
      close(false);
      const name = setWorkspaceWorker.worker?.name ?? LOCAL_WORKER_NAME;
      toast(`${workspaceName} runs on ${name} from its next run.`, 'positive');
    },
  });
  const form = useAppForm({
    defaultValues: { workerId: workerId ?? LOCAL_CHOICE },
    onSubmit: ({ value }) => save.mutateAsync(value.workerId).catch(() => undefined),
  });
  // Reset on close, so the next open starts from where the workspace runs then.
  const close = (next: boolean) => {
    if (next === false) {
      form.reset();
    }
    onOpenChange(next);
  };
  const options = localFirst(workers.data?.workers ?? []).map((worker) =>
    isLocalWorker(worker)
      ? { value: LOCAL_CHOICE, label: worker.name, meta: 'Built in' }
      : { value: worker.id, label: worker.name, meta: worker.host ?? undefined },
  );

  return (
    <DialogLayout
      open={open}
      onOpenChange={close}
      title={`Where ${workspaceName} runs`}
      description="The worker its agent loops run on. A run already going stays where it started."
      loading={workers.isPending}
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
          name="workerId"
          label="Runs on"
          placeholder="Choose a worker"
          options={options}
          searchable={options.length > SEARCHABLE_FROM}
          required
          validators={{ onChange: ({ value }) => (value === '' ? 'Choose a worker.' : undefined) }}
        />
      }
      footerActionsSlot={(dismiss) => (
        <>
          <Button variant="outline" onClick={dismiss} content="Cancel" />
          <form.SubmitButton content="Save" />
        </>
      )}
    />
  );
}
