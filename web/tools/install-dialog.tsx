import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  InstallServerDocument,
  type InstallServerInput,
  MeDocument,
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
import { LoadState } from '@/components/load-state';
import { RowMeta, rowNameFact } from '@/components/row-meta';
import { Button } from '@/components/ui/button';
import { bindToForm } from '@/components/ui/form';
import { FormElement } from '@/components/ui/form-element';
import { KeyValueField, type KeyValueFieldProps } from '@/components/ui/key-value-field';
import { LoadMoreButton } from '@/components/ui/load-more-button';
import { SearchInput } from '@/components/ui/search-input';
import { SegmentedButton, SegmentedGroup } from '@/components/ui/segmented';
import { request } from '@/lib/gql';
import type { KeyValueRow } from '@/lib/key-value';
import { Role } from '@/lib/roles';
import {
  envToText,
  HEADER_NAME_PATTERN,
  HTTP_TRANSPORT_OPTIONS,
  type HttpTransportType,
  STDIO,
  STREAMABLE_HTTP,
  serverNameError,
  textToEnv,
  textToLines,
} from './shapes';

/** Where a server comes from: a registry, a package, or added by hand as a program or an HTTP address. */
type InstallFrom = 'registry' | 'npm' | 'pypi' | 'program' | 'http';

/** One entry in a registry's search results. */
type RegistryEntry = RegistryServersQuery['registryServers']['servers'][number];

/** The ways to add a server, as people read them. */
const FROM: { value: InstallFrom; label: string }[] = [
  { value: 'registry', label: 'From a registry' },
  { value: 'npm', label: 'npm' },
  { value: 'pypi', label: 'PyPI' },
  { value: 'program', label: 'Program (stdio)' },
  { value: 'http', label: 'HTTP address' },
];

/** The ways that add a server by hand: nothing is installed. */
const BY_HAND: ReadonlySet<InstallFrom> = new Set(['program', 'http']);

/** What the URL field suggests for each HTTP transport. */
const URL_PLACEHOLDERS: Readonly<Record<HttpTransportType, string>> = Object.freeze({
  'streamable-http': 'https://mcp.example.com/mcp',
  sse: 'https://mcp.example.com/sse',
});

/** What a header value may not hold: a line break would start another header. */
const LINE_BREAK = /[\r\n]/;

/** What a registry entry's package or remote is, as people read it: a package's registry, or a remote's transport. */
const CHOICE_KINDS: Readonly<Record<string, string>> = Object.freeze({
  npm: 'npm',
  pypi: 'PyPI',
  ...Object.fromEntries(HTTP_TRANSPORT_OPTIONS.map((option) => [option.value, option.label])),
});

/**
 * Checks a header row's name against the others and the router's rule.
 *
 * @param name - The name typed.
 * @param rows - Every row, this one included.
 * @returns What is wrong with it, or undefined.
 */
function headerNameError(name: string, rows: readonly KeyValueRow[]): string | undefined {
  const trimmed = name.trim();
  if (trimmed === '') {
    return 'Name the header.';
  }
  if (HEADER_NAME_PATTERN.test(trimmed) === false) {
    return 'A header name, such as Authorization.';
  }
  const sameName = rows.filter((row) => row.key.trim().toLowerCase() === trimmed.toLowerCase());
  return sameName.length > 1 ? 'That header is listed twice.' : undefined;
}

/**
 * Checks a header row's value.
 *
 * @param value - The value typed.
 * @returns What is wrong with it, or undefined.
 */
function headerValueError(value: string): string | undefined {
  if (value === '') {
    return 'Give the header a value.';
  }
  return LINE_BREAK.test(value) ? 'A header value cannot hold a line break.' : undefined;
}

/**
 * Checks every header row, name then value, and says what is wrong with the first that fails.
 *
 * @param rows - The rows typed.
 * @returns Such as "Header 2: Name the header.", or undefined when every row is a header.
 */
function headersError(rows: readonly KeyValueRow[]): string | undefined {
  for (const [index, row] of rows.entries()) {
    const error = headerNameError(row.key, rows) ?? headerValueError(row.value);
    if (error !== undefined) {
      return `Header ${index + 1}: ${error}`;
    }
  }
  return undefined;
}

/** The header rows, bound to the form as one field. */
const HeadersField = bindToForm<KeyValueFieldProps, KeyValueRow[]>(KeyValueField, 'HeadersField');

/** An HTTP server to start the dialog with, such as one found on the local network. */
export interface HttpServerPrefill {
  name: string;
  url: string;
  /** Headers it needs, each a row with its value left for a person to type. */
  headerNames: readonly string[];
}

/** What the install dialog is given. */
export interface InstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens on "HTTP address" with these filled in. Read when the dialog mounts, so key it by what it holds. */
  prefill?: HttpServerPrefill;
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

/**
 * Installs a server from a registry, npm or PyPI, or adds a program or an HTTP address by hand, then opens its page.
 * An admin can give an HTTP server its secret headers here; anyone else adds them later, through an admin.
 */
export function InstallDialog({ open, onOpenChange, prefill }: InstallDialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<RegistryEntry | null>(null);
  const me = useQuery({ queryKey: ['me'], queryFn: () => request(MeDocument), enabled: open });
  const isAdmin = me.data?.me.role === Role.Admin;
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
      from: (prefill === undefined ? 'registry' : 'http') as InstallFrom,
      registryId: '',
      packageSelector: null as string | null,
      package: '',
      version: '',
      command: '',
      args: '',
      httpTransport: STREAMABLE_HTTP as HttpTransportType,
      url: prefill?.url ?? '',
      headers: (prefill?.headerNames ?? []).map((key): KeyValueRow => ({ key, value: '' })),
      name: prefill?.name ?? '',
      env: '',
    },
    onSubmit: ({ value }) => {
      const name = value.name.trim() === '' ? null : value.name.trim();
      const env = value.from === 'http' ? {} : (textToEnv(value.env).env ?? {});
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
      if (value.from === 'program') {
        return install.mutateAsync({
          name,
          source: { type: 'manual' },
          transport: { type: STDIO, command: value.command.trim(), args: textToLines(value.args) },
          env,
        });
      }
      return install.mutateAsync({
        name,
        source: { type: 'manual' },
        transport: { type: value.httpTransport, url: value.url.trim() },
        ...(isAdmin ? { headers: value.headers.map((row) => ({ name: row.key.trim(), value: row.value })) } : {}),
      });
    },
  });
  // What the form shows depends on these, so the page holds a copy of each the form's own setters keep up.
  const [from, setFrom] = useState<InstallFrom>(form.state.values.from);
  const [registryId, setRegistryId] = useState(form.state.values.registryId);
  const pickFrom = (next: InstallFrom) => {
    form.setFieldValue('from', next);
    setFrom(next);
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
  const isByHand = BY_HAND.has(from);

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
          <LoadState
            compact
            query={results}
            what="the registry's servers"
            count={entries.length}
            emptySlot={<EmptyState compact title="Nothing matches." />}
          />
          <List
            label="Servers in the registry"
            contentSlot={entries.map((entry) => (
              <ListItem
                key={`${entry.name}@${entry.version ?? ''}`}
                title={entry.title ?? entry.name}
                description={entry.description ?? undefined}
                meta={<RowMeta facts={[rowNameFact(entry.title, entry.name), entry.version]} />}
                selected={chosen?.name === entry.name}
                onClick={() => choose(entry)}
              />
            ))}
          />
          <LoadMoreButton
            hasMore={results.hasNextPage}
            onLoadMore={results.fetchNextPage}
            loading={results.isFetchingNextPage}
            label="Show more"
          />
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

  const programPart = (
    <>
      <InputField
        form={form}
        name="command"
        label="Command"
        placeholder="node"
        description="The program, run as the server's own user. Never through a shell."
        required
        validators={{
          onChange: ({ value, fieldApi }) =>
            fieldApi.form.getFieldValue('from') === 'program' && value.trim() === '' ? 'Name the program.' : undefined,
        }}
      />
      <TextareaField
        form={form}
        name="args"
        label="Arguments"
        description="One per line. A line keeps its spaces."
        rows={3}
      />
    </>
  );

  const headersPart = isAdmin ? (
    <HeadersField
      form={form}
      name="headers"
      label="Headers"
      description="Sent with every request, such as Authorization. They are kept as secrets and never shown again."
      keyLabel="Name"
      valueLabel="Value"
      addLabel="Add header"
      removeLabel="Remove header"
      emptyTitle="No headers."
      masked
      validators={{
        onChange: ({ value, fieldApi }) =>
          fieldApi.form.getFieldValue('from') === 'http' ? headersError(value) : undefined,
      }}
    />
  ) : (
    <p className="text-foreground/60 text-sm">
      Headers, such as Authorization, are secrets: an admin sets them under Secrets once it is added.
    </p>
  );

  const httpPart = (
    <>
      <SelectField
        form={form}
        name="httpTransport"
        label="Transport"
        description="Streamable HTTP, unless the server still speaks only SSE, the older transport."
        options={[...HTTP_TRANSPORT_OPTIONS]}
      />
      <form.Subscribe selector={(state) => state.values.httpTransport}>
        {(httpTransport) => (
          <InputField
            form={form}
            name="url"
            label="URL"
            placeholder={URL_PLACEHOLDERS[httpTransport]}
            description={httpTransport === STREAMABLE_HTTP ? undefined : 'The address of its event stream.'}
            required
            validators={{
              onChange: ({ value, fieldApi }) =>
                fieldApi.form.getFieldValue('from') === 'http' && URL.canParse(value.trim()) === false
                  ? 'Enter an http or https URL.'
                  : undefined,
            }}
          />
        )}
      </form.Subscribe>
      {headersPart}
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
        <>
          <SegmentedGroup aria-label="Where it comes from" value={from} onValueChange={pickFrom}>
            {FROM.map((choice) => (
              <SegmentedButton key={choice.value} value={choice.value}>
                {choice.label}
              </SegmentedButton>
            ))}
          </SegmentedGroup>
          {from === 'registry' ? registryPart : null}
          {from === 'npm' || from === 'pypi' ? packagePart : null}
          {from === 'program' ? programPart : null}
          {from === 'http' ? httpPart : null}
          <InputField
            form={form}
            name="name"
            label="Name"
            required={isByHand}
            description={
              isByHand
                ? 'What a run calls it: its tools are <name>__<tool>.'
                : 'What a run calls it: its tools are <name>__<tool>. Left blank, it is named after the package.'
            }
            validators={{
              onChange: ({ value, fieldApi }) => {
                const name = value.trim();
                if (name === '') {
                  return BY_HAND.has(fieldApi.form.getFieldValue('from')) ? 'Name it.' : undefined;
                }
                return serverNameError(name);
              },
            }}
          />
          {from === 'http' ? null : (
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
        </>
      }
      footerActionsSlot={(close) => (
        <>
          <Button variant="outline" onClick={close} content="Cancel" />
          <form.SubmitButton
            disabled={from === 'registry' && chosen === null}
            loadingLabel="Installing…"
            content={isByHand ? 'Add server' : 'Install'}
          />
        </>
      )}
    />
  );
}
