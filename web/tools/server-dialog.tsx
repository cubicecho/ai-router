import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ServerFieldsFragment, UpdateServerDocument } from '@/__generated__/graphql';
import { InputField, NumberField, SwitchField, TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { FieldRow } from '@/components/field-row';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { request } from '@/lib/gql';
import {
  envMetaOf,
  envOf,
  envToText,
  groupsToText,
  linesToText,
  MS_PER_SECOND,
  type ServerTransport,
  STDIO,
  serverNameError,
  sourceOf,
  textToEnv,
  textToGroups,
  textToLines,
  transportOf,
} from './shapes';

/** What the server dialog is given. */
export interface ServerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  server: ServerFieldsFragment;
  /** The router's timeouts for a server that sets none; null while they load. */
  defaults: { idleTimeoutMs: number; callTimeoutMs: number } | null;
}

/**
 * Says what a blank timeout means.
 *
 * @param ms - The router's default, or undefined while it loads.
 * @returns The field's hint.
 */
function blankMeans(ms: number | undefined): string {
  return ms === undefined
    ? "Seconds. Blank is the router's default."
    : `Seconds. Blank is the router's ${ms / MS_PER_SECOND}.`;
}

/** What an update sends. */
interface ServerUpdate {
  name: string;
  displayName: string | null;
  description: string;
  enabled: boolean;
  idleTimeoutMs: number | null;
  callTimeoutMs: number | null;
  env: Record<string, string>;
  extraGroups: number[];
  transport?: ServerTransport;
}

/**
 * Turns a timeout typed in seconds into the milliseconds stored.
 *
 * @param seconds - What was typed, or null for the router's default.
 * @returns The milliseconds, or null.
 */
function toMs(seconds: number | null): number | null {
  return seconds === null ? null : Math.round(seconds * MS_PER_SECOND);
}

/**
 * Checks a timeout typed in seconds.
 *
 * @param seconds - What was typed.
 * @returns What is wrong with it, or undefined.
 */
function timeoutError(seconds: number | null): string | undefined {
  return seconds !== null && seconds <= 0 ? 'More than 0, or blank for the default.' : undefined;
}

/**
 * Edits a server's settings: its name, whether it takes calls, its timeouts and its env. A server added
 * by hand also has its command or address here; an installed one's is the installer's.
 */
export function ServerDialog({ open, onOpenChange, server, defaults }: ServerDialogProps) {
  const queryClient = useQueryClient();
  const transport = transportOf(server.transport);
  const isManual = sourceOf(server.source).type === 'manual';
  const envMeta = envMetaOf(server.envMeta);
  const save = useMutation({
    mutationFn: async (set: ServerUpdate) => {
      const { updateServer } = await request(UpdateServerDocument, { id: server.id, set });
      if (updateServer === null) {
        throw new Error('That server is gone. Someone may have deleted it.');
      }
      return updateServer;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
      onOpenChange(false);
    },
  });
  const form = useAppForm({
    defaultValues: {
      name: server.name,
      displayName: server.displayName ?? '',
      description: server.description,
      enabled: server.enabled,
      idleSeconds:
        server.idleTimeoutMs === null || server.idleTimeoutMs === undefined
          ? null
          : server.idleTimeoutMs / MS_PER_SECOND,
      callSeconds:
        server.callTimeoutMs === null || server.callTimeoutMs === undefined
          ? null
          : server.callTimeoutMs / MS_PER_SECOND,
      env: envToText(envOf(server.env)),
      extraGroups: groupsToText(server.extraGroups),
      command: transport.type === STDIO ? transport.command : '',
      args: transport.type === STDIO ? linesToText(transport.args) : '',
      url: transport.type === STDIO ? '' : transport.url,
    },
    onSubmit: ({ value }) => {
      const set: ServerUpdate = {
        name: value.name.trim(),
        displayName: value.displayName.trim() === '' ? null : value.displayName.trim(),
        description: value.description,
        enabled: value.enabled,
        idleTimeoutMs: toMs(value.idleSeconds),
        callTimeoutMs: toMs(value.callSeconds),
        env: textToEnv(value.env).env ?? {},
        extraGroups: textToGroups(value.extraGroups).groups ?? [],
      };
      if (isManual) {
        set.transport =
          transport.type === STDIO
            ? { type: STDIO, command: value.command.trim(), args: textToLines(value.args) }
            : { type: transport.type, url: value.url.trim() };
      }
      return save.mutateAsync(set);
    },
  });

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`Edit ${server.name}`}
      description="How agents name it, whether it takes calls, and what it runs with."
      size="lg"
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
            description="A run names its tools <name>__<tool>, so renaming it breaks agents that use the old name."
            required
            validators={{ onChange: ({ value }) => serverNameError(value.trim()) }}
          />
          <InputField form={form} name="displayName" label="Display name" />
          {isManual && transport.type === STDIO ? (
            <>
              <InputField
                form={form}
                name="command"
                label="Command"
                description="The program, run as the server's own user. Never through a shell."
                required
                validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Name the program.' : undefined) }}
              />
              <TextareaField
                form={form}
                name="args"
                label="Arguments"
                description="One per line. A line keeps its spaces."
                rows={3}
              />
            </>
          ) : null}
          {isManual && transport.type !== STDIO ? (
            <InputField
              form={form}
              name="url"
              label="Address"
              description="Moving it to another site drops its sign-in."
              required
              validators={{
                onChange: ({ value }) => (URL.canParse(value.trim()) ? undefined : 'Enter an http or https URL.'),
              }}
            />
          ) : null}
          {transport.type === STDIO ? (
            <TextareaField
              form={form}
              name="env"
              label="Environment"
              description="One per line, as NAME=value. They are shown here, so set secret ones under Secrets."
              rows={4}
              validators={{
                onChange: ({ value }) => {
                  const parsed = textToEnv(value);
                  if (parsed.env === null) {
                    return parsed.error;
                  }
                  const secret = Object.keys(parsed.env).find((name) => envMeta[name]?.isSecret === true);
                  return secret === undefined ? undefined : `${secret} is a secret: set it under Secrets.`;
                },
              }}
            />
          ) : null}
          {transport.type === STDIO ? (
            <InputField
              form={form}
              name="extraGroups"
              label="Extra groups"
              description="Group ids it also runs with, for a folder mounted from the host, such as 100 (users). Give that folder the group on the host, with g+rwX and g+s."
              validators={{ onChange: ({ value }) => textToGroups(value).error ?? undefined }}
            />
          ) : null}
          <FieldRow
            contentSlot={
              <>
                {transport.type === STDIO ? (
                  <NumberField
                    form={form}
                    name="idleSeconds"
                    label="Stops when idle for"
                    description={blankMeans(defaults?.idleTimeoutMs)}
                    min={1}
                    validators={{ onChange: ({ value }) => timeoutError(value) }}
                  />
                ) : null}
                <NumberField
                  form={form}
                  name="callSeconds"
                  label="A call may take"
                  description={blankMeans(defaults?.callTimeoutMs)}
                  min={1}
                  validators={{ onChange: ({ value }) => timeoutError(value) }}
                />
              </>
            }
          />
          <TextareaField form={form} name="description" label="Description" rows={2} />
          <SwitchField form={form} name="enabled" label="Takes calls" description="Off, runs don't see its tools." />
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton requireChanges content="Save changes" />
        </>
      )}
    />
  );
}
