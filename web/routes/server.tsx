import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { DeleteServerDocument, MeDocument, ServerDocument, UpdateServerDocument } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { LoadState } from '@/components/load-state';
import { PageLayout, titleColumn } from '@/components/page-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { ArrowLeft, Pencil } from '@/components/ui/icons';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { request } from '@/lib/gql';
import { Role } from '@/lib/roles';
import { openTab } from '@/lib/tab-search';
import { cn } from '@/lib/utils';
import { ActivitySection } from '@/tools/activity-section';
import { InstancesSection } from '@/tools/instances-section';
import { LoginSection } from '@/tools/login-section';
import { isRequiredSecretUnset, SecretsSection } from '@/tools/secrets-section';
import { ServerDialog } from '@/tools/server-dialog';
import { SERVER_TABS, type ServerTab, serverTabsOf, validateServerSearch } from '@/tools/server-tabs';
import {
  BUILTIN,
  commandLine,
  describeSource,
  describeTimeout,
  describeTransport,
  envMetaOf,
  envOf,
  groupsToText,
  HTTP_TRANSPORT_HINTS,
  SSE,
  STDIO,
  STREAMABLE_HTTP,
  sourceOf,
  transportOf,
} from '@/tools/shapes';
import { ToolsSection } from '@/tools/tools-section';

/** What each tab is called. */
const TAB_LABELS = {
  overview: 'Overview',
  tools: 'Tools',
  instances: 'Instances',
  secrets: 'Secrets',
  login: 'Login',
  activity: 'Activity',
} as const satisfies Record<ServerTab, string>;

/**
 * One MCP server, in tabs: how it runs, its tools, its instances, its secrets and login, and what its tools have
 * been used for. The admin server's page has no Secrets or Login and can't be edited, only turned off and on.
 */
export function ServerRoute() {
  const { serverId } = useParams({ from: '/app/mcp-servers/$serverId' });
  const search = useSearch({ from: '/app/mcp-servers/$serverId' });
  const navigate = useNavigate({ from: '/mcp-servers/$serverId' });
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const me = useQuery({ queryKey: ['me'], queryFn: () => request(MeDocument) });
  const server = useQuery({
    queryKey: ['servers', serverId],
    queryFn: () => request(ServerDocument, { id: serverId }),
  });
  const remove = useMutation({
    mutationFn: () => request(DeleteServerDocument, { id: serverId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['servers'] });
      void navigate({ to: '/mcp-servers' });
    },
  });
  // The admin server's one setting a person changes here: whether it takes calls.
  const switchOn = useMutation({
    mutationFn: (enabled: boolean) => request(UpdateServerDocument, { id: serverId, set: { enabled } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['servers'] }),
  });
  const record = server.data?.server ?? undefined;
  const defaults = server.data?.serverDefaults;
  const isAdmin = me.data?.me.role === Role.Admin;
  const back = (
    <Button
      variant="outline"
      size="sm"
      iconSlot={<ArrowLeft />}
      linkSlot={<Link to="/mcp-servers" />}
      content="MCP Servers"
    />
  );

  if (record === undefined) {
    return (
      <PageLayout
        title="MCP server"
        backSlot={back}
        width="page"
        loading={server.isPending}
        contentSlot={
          <LoadState query={server} what="this server" record={record} notFoundLabel="Server not found" level={2} />
        }
      />
    );
  }

  const transport = transportOf(record.transport);
  const isBuiltin = transport.type === BUILTIN;
  const envMeta = envMetaOf(record.envMeta);
  const env = Object.entries(envOf(record.env));
  const unsetEnv = Object.entries(envMeta).filter(
    ([name, meta]) => meta.isSecret !== true && env.some(([set]) => set === name) === false,
  );
  const { login } = record;
  const tabs = serverTabsOf({ isBuiltin, hasLogin: login !== null && login !== undefined });
  // The address is checked against every tab a server can have, so a link to one this server lacks opens the first.
  const named = openTab(SERVER_TABS, search);
  const tab = tabs.includes(named) ? named : SERVER_TABS[0];
  const hasEnv = transport.type === STDIO || env.length > 0 || unsetEnv.length > 0;

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => void navigate({ search: validateServerSearch({ tab: next }), replace: true })}
      className="h-full"
    >
      <PageLayout
        title={
          <span className="flex items-center gap-2">
            {record.displayName ?? record.name}
            {isBuiltin ? <Badge variant="secondary">Built in</Badge> : null}
            {record.enabled ? null : <Badge variant="outline">Off</Badge>}
          </span>
        }
        description={record.description === '' ? undefined : record.description}
        backSlot={back}
        width="page"
        actionSlot={
          isBuiltin ? (
            <Button
              variant="outline"
              loading={switchOn.isPending}
              onClick={() => switchOn.mutate(record.enabled === false)}
              content={record.enabled ? 'Turn off' : 'Turn on'}
            />
          ) : (
            <>
              <Button variant="outline" iconSlot={<Pencil />} onClick={() => setIsEditing(true)} content="Edit" />
              <ConfirmButton
                title={`Delete ${record.name}?`}
                description="It is stopped and its folder removed, with its secrets and every workspace's entry for it. Agents using its tools stop finding them."
                requireText={record.name}
                onConfirm={() => remove.mutate()}
                content="Delete"
              />
            </>
          )
        }
        headerBarSlot={
          <div className={cn(titleColumn('page'), 'pb-3')}>
            <TabsList aria-label="MCP server">
              {tabs.map((value) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  trailingSlot={
                    value === 'secrets' && isRequiredSecretUnset(record.secrets, envMeta) ? (
                      <Badge variant="warning" label="A required secret is not set" />
                    ) : undefined
                  }
                >
                  {TAB_LABELS[value]}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        }
        contentSlot={
          <>
            <TabsContent value="overview" className="flex flex-col gap-4">
              <PropertyList
                contentSlot={
                  <>
                    <PropertyRow
                      label="Name"
                      value={record.name}
                      valueClassName="font-mono"
                      hint="A run sees its tools as name__tool."
                      actionSlot={<CopyButton value={record.name} label="Copy name" />}
                    />
                    {transport.type === STDIO ? (
                      <>
                        <PropertyRow
                          label="Runs"
                          value={commandLine(transport)}
                          valueClassName="font-mono break-all"
                          hint="A program the router starts, in its own folder."
                        />
                        <PropertyRow
                          label="Runs as user"
                          value={String(record.childUid)}
                          valueClassName="font-mono"
                          hint="Its own, walled off from the router and from other servers. A workspace's instance has one of its own."
                        />
                        <PropertyRow
                          label="Extra groups"
                          value={record.extraGroups.length === 0 ? 'None' : groupsToText(record.extraGroups)}
                          valueClassName="font-mono"
                          hint="For folders mounted from the host that belong to one of these groups."
                        />
                      </>
                    ) : null}
                    {transport.type === STREAMABLE_HTTP || transport.type === SSE ? (
                      <>
                        <PropertyRow label="Transport" value={describeTransport(transport)} />
                        <PropertyRow
                          label="URL"
                          value={transport.url}
                          valueClassName="font-mono break-all"
                          hint={HTTP_TRANSPORT_HINTS[transport.type]}
                          actionSlot={<CopyButton value={transport.url} label="Copy URL" />}
                        />
                      </>
                    ) : null}
                    {isBuiltin ? (
                      <PropertyRow
                        label="Runs"
                        value="Inside the router"
                        hint="The router's own management, as tools. A workspace's entry for it grants its agent runs roles, and an agent reaches it only by naming it."
                      />
                    ) : null}
                    <PropertyRow label="From" value={describeSource(sourceOf(record.source))} />
                    <PropertyRow label="Takes calls" value={record.enabled ? 'Yes' : 'No'} />
                    {transport.type === STDIO ? (
                      <PropertyRow
                        label="Stops when idle for"
                        value={describeTimeout(record.idleTimeoutMs ?? null, defaults?.idleTimeoutMs ?? null)}
                      />
                    ) : null}
                    <PropertyRow
                      label="A call may take"
                      value={describeTimeout(record.callTimeoutMs ?? null, defaults?.callTimeoutMs ?? null)}
                    />
                  </>
                }
              />
              {hasEnv ? (
                <Section
                  title="Env vars"
                  description="Set in its environment when the router starts it. Secret ones are under Secrets, and never shown."
                  contentSlot={
                    env.length === 0 && unsetEnv.length === 0 ? (
                      <EmptyState compact title="No env vars set." />
                    ) : (
                      <PropertyList
                        contentSlot={
                          <>
                            {env.map(([name, value]) => (
                              <PropertyRow
                                key={name}
                                label={name}
                                labelClassName="font-mono"
                                value={value}
                                valueClassName="font-mono break-all"
                                hint={envMeta[name]?.description}
                              />
                            ))}
                            {unsetEnv.map(([name, meta]) => (
                              <PropertyRow
                                key={name}
                                label={name}
                                labelClassName="font-mono"
                                value={
                                  meta.isRequired === true ? (
                                    <Badge variant="warning-soft">Required, not set</Badge>
                                  ) : (
                                    <Badge variant="outline">Not set</Badge>
                                  )
                                }
                                hint={meta.description}
                              />
                            ))}
                          </>
                        }
                      />
                    )
                  }
                />
              ) : null}
            </TabsContent>
            <TabsContent value="tools">
              <ToolsSection
                serverId={record.id}
                serverName={record.name}
                enabled={record.enabled}
                canTry={isBuiltin === false}
              />
            </TabsContent>
            <TabsContent value="instances">
              <InstancesSection serverId={record.id} />
            </TabsContent>
            {isBuiltin ? null : (
              <TabsContent value="secrets">
                <SecretsSection
                  serverId={record.id}
                  serverName={record.name}
                  transport={transport}
                  secrets={record.secrets}
                  envMeta={envMeta}
                  isAdmin={isAdmin}
                />
              </TabsContent>
            )}
            {login === null || login === undefined ? null : (
              // Kept mounted while hidden: a sign-in started here reports back by message from its popup, which has
              // to find the section listening even after the reader moves to another tab.
              <TabsContent value="login" forceMount className="data-[state=inactive]:hidden">
                <LoginSection server={{ ...record, login }} isAdmin={isAdmin} />
              </TabsContent>
            )}
            <TabsContent value="activity">
              <ActivitySection serverId={record.id} />
            </TabsContent>
            {isBuiltin ? null : (
              <ServerDialog
                key={record.updatedAt}
                open={isEditing}
                onOpenChange={setIsEditing}
                server={record}
                defaults={defaults ?? null}
                isAdmin={isAdmin}
              />
            )}
          </>
        }
      />
    </Tabs>
  );
}
