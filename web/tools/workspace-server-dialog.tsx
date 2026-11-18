import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  CreateWorkspaceServerDocument,
  UpdateWorkspaceServerDocument,
  type WorkspaceServerFieldsFragment,
  type WorkspaceServersQuery,
} from '@/__generated__/graphql';
import { InputField, SelectField, TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';
import { envOf, envToText, linesToText, STDIO, stringsOf, textToEnv, textToLines, transportOf } from './shapes';

/** How many servers the picker lists before it offers a search box. */
const SEARCHABLE_FROM = 8;

/** A server an entry may configure. */
type ServerChoice = WorkspaceServersQuery['servers'][number];

/** What the workspace server dialog is given. */
export interface WorkspaceServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** The entry to edit, or null to add one. */
  entry: WorkspaceServerFieldsFragment | null;
  /** Every server, for a new entry to pick from. */
  servers: readonly ServerChoice[];
  /** The servers this workspace already has an entry for, which a new one can't pick again. */
  taken: readonly string[];
}

/** What a save sends. */
interface EntryValues {
  env: Record<string, string>;
  args: string[] | null;
  url: string | null;
}

/**
 * Adds or edits a workspace's entry for a server: the env, arguments or address its agent runs use
 * in place of the server's own.
 */
export function WorkspaceServerDialog({
  open,
  onOpenChange,
  workspaceId,
  entry,
  servers,
  taken,
}: WorkspaceServerDialogProps) {
  const queryClient = useQueryClient();
  const isEdit = entry !== null;
  const save = useMutation({
    mutationFn: async ({ serverId, ...values }: EntryValues & { serverId: string }) => {
      if (entry === null) {
        return (await request(CreateWorkspaceServerDocument, { values: { workspaceId, serverId, ...values } }))
          .createWorkspaceServer;
      }
      const { updateWorkspaceServer } = await request(UpdateWorkspaceServerDocument, { id: entry.id, set: values });
      if (updateWorkspaceServer === null) {
        throw new Error('That entry is gone. Someone may have removed it.');
      }
      return updateWorkspaceServer;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
      onOpenChange(false);
    },
  });
  const args = entry === null || entry.args === null || entry.args === undefined ? null : stringsOf(entry.args);
  const form = useAppForm({
    defaultValues: {
      serverId: entry?.serverId ?? '',
      env: entry === null ? '' : envToText(envOf(entry.env)),
      args: args === null ? '' : linesToText(args),
      url: entry?.url ?? '',
    },
    onSubmit: ({ value }) => {
      const picked = servers.find((server) => server.id === value.serverId);
      const isProgram = picked === undefined || transportOf(picked.transport).type === STDIO;
      const argLines = textToLines(value.args);
      return save.mutateAsync({
        serverId: value.serverId,
        env: isProgram ? (textToEnv(value.env).env ?? {}) : {},
        args: isProgram && argLines.length > 0 ? argLines : null,
        url: isProgram || value.url.trim() === '' ? null : value.url.trim(),
      });
    },
  });
  // Which fields show depends on the server picked, so the dialog keeps a copy the field's listener updates.
  const [serverId, setServerId] = useState(form.state.values.serverId);
  const picked = servers.find((server) => server.id === serverId);
  const isProgram = picked === undefined || transportOf(picked.transport).type === STDIO;
  const options = servers
    .filter((server) => server.id === entry?.serverId || taken.includes(server.id) === false)
    .map((server) => ({ value: server.id, label: server.displayName ?? server.name }));

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `${entry.server?.name ?? 'Server'} in this workspace` : 'Configure a server'}
      description="Settings this workspace's agent runs use in place of the server's own. An entry never adds the server to a run."
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
          {isEdit ? null : (
            <SelectField
              form={form}
              name="serverId"
              label="Server"
              placeholder={options.length === 0 ? 'Every server has an entry already' : 'Choose a server'}
              options={options}
              searchable={options.length > SEARCHABLE_FROM}
              listeners={{ onChange: ({ value }) => setServerId(value) }}
              required
              validators={{ onChange: ({ value }) => (value === '' ? 'Choose a server.' : undefined) }}
            />
          )}
          {isProgram ? (
            <>
              <TextareaField
                form={form}
                name="env"
                label="Environment"
                description="One per line, as NAME=value, laid over the server's own. Set secret ones as secrets."
                rows={3}
                validators={{ onChange: ({ value }) => textToEnv(value).error ?? undefined }}
              />
              <TextareaField
                form={form}
                name="args"
                label="Arguments"
                description="One per line, in place of the server's own. Left blank, it keeps them."
                rows={3}
              />
            </>
          ) : (
            <InputField
              form={form}
              name="url"
              label="Address"
              description="In place of the server's own. Left blank, it keeps it."
              validators={{
                onChange: ({ value }) =>
                  value.trim() === '' || URL.canParse(value.trim()) ? undefined : 'Enter an http or https URL.',
              }}
            />
          )}
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton
            variant={isEdit ? 'positive' : 'info'}
            requireChanges={isEdit}
            content={isEdit ? 'Save changes' : 'Add entry'}
          />
        </>
      )}
    />
  );
}
