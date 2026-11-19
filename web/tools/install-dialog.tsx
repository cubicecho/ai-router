import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  InstallServerDocument,
  type InstallServerInput,
  RegistriesDocument,
  RegistryServersDocument,
  type RegistryServersQuery,
} from '@/__generated__/graphql';
import { InputField, SelectField, TextareaField, useAppForm } from '@/components/app-form';
import { DialogLayout } from '@/components/dialog-layout';
import { EmptyState } from '@/components/empty-state';
import { FieldRow } from '@/components/field-row';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadError, RowSkeleton } from '@/components/load-state';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { SearchInput } from '@/components/ui/search-input';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import { request } from '@/lib/gql';
import { envToText, STDIO, STREAMABLE_HTTP, serverNameError, textToEnv, textToLines } from './shapes';

/** Where a server is installed from. */
type InstallFrom = 'registry' | 'npm' | 'pypi' | 'manual';

/** How a server added by hand is reached. */
type HandTransport = typeof STDIO | typeof STREAMABLE_HTTP;

/** One entry in a registry's search results. */
type RegistryEntry = RegistryServersQuery['registryServers']['servers'][number];

/** The ways to install, as people read them. */
const FROM: { value: InstallFrom; label: string }[] = [
  { value: 'registry', label: 'From a registry' },
  { value: 'npm', label: 'npm' },
  { value: 'pypi', label: 'PyPI' },
  { value: 'manual', label: 'By hand' },
];

/** What a registry entry's package or remote is, as people read it. */
const CHOICE_KINDS: Readonly<Record<string, string>> = { npm: 'npm', pypi: 'PyPI', 'streamable-http': 'Remote' };

/** What the install dialog is given. */
export interface InstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Says what a registry entry's choice is.
 *
 * @param choice - One of its packages or remotes.
 * @returns Such as "npm: @scope/pkg 1.2.0".
 */
function choiceLabel(choice: RegistryEntry['choices'][number]): string {
  const version = choice.version === null || choice.version === undefined ? '' : ` ${choice.version}`;
  return `${CHOICE_KINDS[choice.kind] ?? choice.kind}: ${choice.identifier}${version}`;
}

/** Installs a server from a registry, npm or PyPI, or adds one by hand, then opens its page. */
export function InstallDialog({ open, onOpenChange }: InstallDialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<RegistryEntry | null>(null);
  const registries = useQuery({
    queryKey: ['registries'],
    queryFn: () => request(RegistriesDocument),
    enabled: open,
  });
  const install = useMutation({
    mutationFn: async (input: InstallServerInput) => (await request(InstallServerDocument, { input })).installServer,
    onSuccess: (server) => {
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
      onOpenChange(false);
      void navigate({ to: '/mcp-servers/$serverId', params: { serverId: server.id } });
    },
  });
  const form = useAppForm({
    defaultValues: {
      from: 'registry' as InstallFrom,
      registryId: '',
      packageSelector: null as string | null,
      package: '',
      version: '',
      transport: STDIO as HandTransport,
      command: '',
      args: '',
      url: '',
      name: '',
      env: '',
    },
    onSubmit: ({ value }) => {
      const name = value.name.trim() === '' ? null : value.name.trim();
      const env = value.transport === STDIO || value.from !== 'manual' ? (textToEnv(value.env).env ?? {}) : {};
      const registry = registries.data?.registries.find((entry) => entry.id === value.registryId);
      if (value.from === 'registry') {
        return install.mutateAsync({
          name,
          source: { type: 'registry', registry: registry?.name ?? '', serverName: chosen?.name ?? '' },
          packageSelector: value.packageSelector,
          env,
        });
      }
      if (value.from === 'npm' || value.from === 'pypi') {
        const version = value.version.trim();
        return install.mutateAsync({
          name,
          source: { type: value.from, package: value.package.trim(), version: version === '' ? null : version },
          env,
        });
      }
      return install.mutateAsync({
        name,
        source: { type: 'manual' },
        transport:
          value.transport === STDIO
            ? { type: STDIO, command: value.command.trim(), args: textToLines(value.args) }
            : { type: STREAMABLE_HTTP, url: value.url.trim() },
        env,
      });
    },
  });
  // What the form shows depends on these, so the page holds a copy of each the form's own setters keep up.
  const [from, setFrom] = useState<InstallFrom>(form.state.values.from);
  const [transport, setTransport] = useState<HandTransport>(form.state.values.transport);
  const [registryId, setRegistryId] = useState(form.state.values.registryId);
  const pickFrom = (next: InstallFrom) => {
    form.setFieldValue('from', next);
    setFrom(next);
  };
  const pickTransport = (next: HandTransport) => {
    form.setFieldValue('transport', next);
    setTransport(next);
  };
  const results = useInfiniteQuery({
    queryKey: ['registries', registryId, 'servers', search],
    queryFn: ({ pageParam }) =>
      request(RegistryServersDocument, { registryId, search: search === '' ? null : search, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.registryServers.nextCursor,
    enabled: open && from === 'registry' && registryId !== '',
    meta: { quiet: true },
  });
  const entries = results.data?.pages.flatMap((page) => page.registryServers.servers) ?? [];
  const choose = (entry: RegistryEntry) => {
    setChosen(entry);
    form.setFieldValue('packageSelector', null);
  };
  const isManual = from === 'manual';

  const registryPart = (
    <>
      <SelectField
        form={form}
        name="registryId"
        label="Registry"
        placeholder={registries.data?.registries.length === 0 ? 'Add a registry first' : 'Choose a registry'}
        options={(registries.data?.registries ?? []).map((registry) => ({ value: registry.id, label: registry.name }))}
        listeners={{
          onChange: ({ value }) => {
            setRegistryId(value);
            setChosen(null);
          },
        }}
        validators={{
          onChange: ({ value, fieldApi }) =>
            fieldApi.form.getFieldValue('from') === 'registry' && value === '' ? 'Choose a registry.' : undefined,
        }}
      />
      {registryId === '' ? null : (
        <div className="grid gap-2">
          <SearchInput label="Search the registry" placeholder="Search by name" onSettledText={setSearch} />
          {results.isError ? (
            <LoadError error={results.error} onRetry={results.refetch} what="the registry's servers" compact />
          ) : results.isPending ? (
            <RowSkeleton rows={3} />
          ) : entries.length === 0 ? (
            <EmptyState compact title="Nothing matches." />
          ) : (
            <>
              <List
                label="Servers in the registry"
                contentSlot={entries.map((entry) => (
                  <ListItem
                    key={`${entry.name}@${entry.version ?? ''}`}
                    title={entry.title ?? entry.name}
                    description={entry.description ?? entry.name}
                    meta={entry.version ?? undefined}
                    selected={chosen?.name === entry.name}
                    onClick={() => choose(entry)}
                  />
                ))}
              />
              {results.hasNextPage ? (
                <Button
                  variant="outline"
                  size="sm"
                  loading={results.isFetchingNextPage}
                  onClick={() => void results.fetchNextPage()}
                  content="Show more"
                />
              ) : null}
            </>
          )}
        </div>
      )}
      {chosen === null ? null : (
        <SelectField
          form={form}
          name="packageSelector"
          label={`Install ${chosen.title ?? chosen.name} as`}
          description="Which of its packages or remotes to use."
          options={chosen.choices.map((choice) => ({ value: choice.selector, label: choiceLabel(choice) }))}
          clearable
          emptyLabel="Let the router pick: npm, then PyPI, then remote"
        />
      )}
    </>
  );

  const packagePart = (
    <FieldRow
      contentSlot={
        <>
          <InputField
            form={form}
            name="package"
            label="Package"
            placeholder={from === 'npm' ? '@modelcontextprotocol/server-everything' : 'mcp-server-fetch'}
            required
            validators={{
              onChange: ({ value, fieldApi }) =>
                (fieldApi.form.getFieldValue('from') === 'npm' || fieldApi.form.getFieldValue('from') === 'pypi') &&
                value.trim() === ''
                  ? 'Name the package.'
                  : undefined,
            }}
          />
          <InputField form={form} name="version" label="Version" description="Left blank, the latest." />
        </>
      }
    />
  );

  const manualPart = (
    <>
      <SegmentedGroup aria-label="How the router reaches it" value={transport} onValueChange={pickTransport}>
        <SegmentedButton value={STDIO}>A program it starts</SegmentedButton>
        <SegmentedButton value={STREAMABLE_HTTP}>An address</SegmentedButton>
      </SegmentedGroup>
      {transport === STDIO ? (
        <>
          <InputField
            form={form}
            name="command"
            label="Command"
            placeholder="node"
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
      ) : (
        <InputField
          form={form}
          name="url"
          label="Address"
          placeholder="https://mcp.example.com/mcp"
          required
          validators={{
            onChange: ({ value }) => (URL.canParse(value.trim()) ? undefined : 'Enter an http or https URL.'),
          }}
        />
      )}
    </>
  );

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title="Add a server"
      description="Installing from npm or PyPI runs the install as the server's own user, which can take a minute."
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
          <SegmentedGroup aria-label="Where it comes from" value={from} onValueChange={pickFrom}>
            {FROM.map((choice) => (
              <SegmentedButton key={choice.value} value={choice.value}>
                {choice.label}
              </SegmentedButton>
            ))}
          </SegmentedGroup>
          {from === 'registry' ? registryPart : null}
          {from === 'npm' || from === 'pypi' ? packagePart : null}
          {isManual ? manualPart : null}
          <InputField
            form={form}
            name="name"
            label="Name"
            required={isManual}
            description={
              isManual
                ? 'What a run calls it: its tools are <name>__<tool>.'
                : 'What a run calls it: its tools are <name>__<tool>. Left blank, it is named after the package.'
            }
            validators={{
              onChange: ({ value, fieldApi }) => {
                const name = value.trim();
                if (name === '') {
                  return fieldApi.form.getFieldValue('from') === 'manual' ? 'Name it.' : undefined;
                }
                return serverNameError(name);
              },
            }}
          />
          {isManual && transport === STREAMABLE_HTTP ? null : (
            <TextareaField
              form={form}
              name="env"
              label="Environment"
              description="One per line, as NAME=value. They are shown here, so set secret ones under Secrets once it is added."
              placeholder={envToText({ LOG_LEVEL: 'info' })}
              rows={3}
              validators={{ onChange: ({ value }) => textToEnv(value).error ?? undefined }}
            />
          )}
        </div>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton
            disabled={from === 'registry' && chosen === null}
            loadingLabel="Installing…"
            content={isManual ? 'Add server' : 'Install'}
          />
        </>
      )}
    />
  );
}
