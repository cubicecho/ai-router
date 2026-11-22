import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  CreateWorkspaceServerDocument,
  UpdateWorkspaceServerDocument,
  type WorkspaceServerFieldsFragment,
  type WorkspaceServersQuery,
} from '@/__generated__/graphql';
import { CheckboxField, InputField, SelectField, TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';
import { ADMIN_ROLE_CHOICES, type AdminRole, checkedRoles, roleChecksOf, rolesOf } from './admin-roles';
import {
  BUILTIN,
  envOf,
  envToText,
  linesToText,
  STDIO,
  stringsOf,
  textToEnv,
  textToLines,
  transportOf,
} from './shapes';

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
  /** For the admin server only. Every other entry's are empty. */
  roles: AdminRole[];
}

/** What a server is, as the dialog shows its fields: a program, an address, or the admin server. */
type EntryKind = 'program' | 'address' | 'roles';

/**
 * Says which fields an entry for a server takes.
 *
 * @param server - The server picked, or undefined before one is.
 * @returns Env and arguments for a program, an address for a remote server, roles for the admin server.
 */
function kindOf(server: ServerChoice | undefined): EntryKind {
  const type = server === undefined ? STDIO : transportOf(server.transport).type;
  return ENTRY_KINDS[type];
}

/** Which fields an entry takes, by its server's transport. */
const ENTRY_KINDS: Readonly<Record<ReturnType<typeof transportOf>['type'], EntryKind>> = Object.freeze({
  stdio: 'program',
  'streamable-http': 'address',
  sse: 'address',
  [BUILTIN]: 'roles',
});

/**
 * Adds or edits a workspace's entry for a server: the env, arguments or address its agent runs use
 * in place of the server's own, or for the admin server, what its agent runs may do through it.
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
      roles: roleChecksOf(rolesOf(entry?.roles)),
    },
    onSubmit: ({ value }) => {
      const kind = kindOf(servers.find((server) => server.id === value.serverId));
      const isProgram = kind === 'program';
      const argLines = textToLines(value.args);
      return save.mutateAsync({
        serverId: value.serverId,
        env: isProgram ? (textToEnv(value.env).env ?? {}) : {},
        args: isProgram && argLines.length > 0 ? argLines : null,
        url: kind === 'address' && value.url.trim() !== '' ? value.url.trim() : null,
        roles: kind === 'roles' ? checkedRoles(value.roles) : [],
      });
    },
  });
  // Which fields show depends on the server picked, so the dialog keeps a copy the field's listener updates.
  const [serverId, setServerId] = useState(form.state.values.serverId);
  const kind = kindOf(servers.find((server) => server.id === serverId));
  const options = servers
    .filter((server) => server.id === entry?.serverId || taken.includes(server.id) === false)
    .map((server) => ({ value: server.id, label: server.displayName ?? server.name }));

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? `${entry.server?.name ?? 'Server'} in this workspace` : 'Add a server'}
      description={
        kind === 'roles'
          ? "What this workspace's agent runs may do through the admin server. Every agent here reaches it, unless turned off for one on the Agents tab."
          : "Every agent here reaches it, unless turned off for one on the Agents tab. Anything set here replaces the server's own setting for this workspace's runs."
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
          {kind === 'roles' ? (
            <div className="grid gap-3">
              {ADMIN_ROLE_CHOICES.map((choice) => (
                <CheckboxField
                  key={choice.role}
                  form={form}
                  name={`roles.${choice.role}`}
                  label={choice.label}
                  description={choice.description}
                />
              ))}
            </div>
          ) : null}
          {kind === 'program' ? (
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
          ) : null}
          {kind === 'address' ? (
            <InputField
              form={form}
              name="url"
              label="URL"
              description="In place of the server's own. Left blank, it keeps it."
              validators={{
                onChange: ({ value }) =>
                  value.trim() === '' || URL.canParse(value.trim()) ? undefined : 'Enter an http or https URL.',
              }}
            />
          ) : null}
        </>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton requireChanges={isEdit} content={isEdit ? 'Save changes' : 'Add entry'} />
        </>
      )}
    />
  );
}
