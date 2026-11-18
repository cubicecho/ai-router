import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { DeleteServerDocument, MeDocument, ServerDocument } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Pencil } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { Role } from '@/lib/roles';
import { ActivitySection } from '@/tools/activity-section';
import { InstancesSection } from '@/tools/instances-section';
import { LoginSection } from '@/tools/login-section';
import { SecretsSection } from '@/tools/secrets-section';
import { ServerDialog } from '@/tools/server-dialog';
import {
  commandLine,
  describeSource,
  describeTimeout,
  envMetaOf,
  envOf,
  groupsToText,
  STDIO,
  sourceOf,
  transportOf,
} from '@/tools/shapes';
import { ToolsSection } from '@/tools/tools-section';

/** One MCP server: how it runs, its secrets and login, its instances, its tools and what they have been used for. */
export function ServerRoute() {
  const { serverId } = useParams({ from: '/app/servers/$serverId' });
  const navigate = useNavigate();
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
      void navigate({ to: '/servers' });
    },
  });
  const record = server.data?.server ?? undefined;
  const defaults = server.data?.serverDefaults;
  const isAdmin = me.data?.me.role === Role.Admin;
  const back = (
    <Button variant="outline" size="sm" iconSlot={<ArrowLeft />} linkSlot={<Link to="/servers" />} content="Servers" />
  );

  if (record === undefined) {
    return (
      <PageLayout
        title="Server"
        backSlot={back}
        loading={server.isPending}
        contentSlot={
          <LoadState query={server} what="this server" record={record} notFoundLabel="Server not found" level={2} />
        }
      />
    );
  }

  const transport = transportOf(record.transport);
  const envMeta = envMetaOf(record.envMeta);
  const env = Object.entries(envOf(record.env));
  const { login } = record;
  return (
    <PageLayout
      title={record.displayName ?? record.name}
      description={record.description === '' ? undefined : record.description}
      backSlot={back}
      width="prose"
      actionSlot={
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
      }
      contentSlot={
        <>
          <PropertyList
            contentSlot={
              <>
                <PropertyRow
                  label="Name"
                  value={record.name}
                  valueClassName="font-mono"
                  hint="A run sees its tools as name__tool."
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
                ) : (
                  <PropertyRow
                    label="Address"
                    value={transport.url}
                    valueClassName="font-mono break-all"
                    hint="Reached over streamable HTTP."
                  />
                )}
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
                {env.map(([name, value]) => (
                  <PropertyRow
                    key={name}
                    label={name}
                    labelClassName="font-mono"
                    value={value}
                    valueClassName="font-mono break-all"
                    hint={envMeta[name]?.description ?? 'Env var'}
                  />
                ))}
                {Object.entries(envMeta)
                  .filter(([name, meta]) => meta.isSecret !== true && env.some(([set]) => set === name) === false)
                  .map(([name, meta]) => (
                    <PropertyRow
                      key={name}
                      label={name}
                      labelClassName="font-mono"
                      value={meta.isRequired === true ? 'Not set, and it needs one' : 'Not set'}
                      hint={meta.description ?? 'Env var'}
                    />
                  ))}
              </>
            }
          />
          <SecretsSection
            serverId={record.id}
            serverName={record.name}
            transport={transport}
            secrets={record.secrets}
            envMeta={envMeta}
            isAdmin={isAdmin}
          />
          {login === null || login === undefined ? null : (
            <LoginSection server={{ ...record, login }} isAdmin={isAdmin} />
          )}
          <InstancesSection serverId={record.id} />
          <ToolsSection serverId={record.id} serverName={record.name} enabled={record.enabled} />
          <ActivitySection serverId={record.id} />
          <ServerDialog
            key={record.updatedAt}
            open={isEditing}
            onOpenChange={setIsEditing}
            server={record}
            defaults={defaults ?? null}
            isAdmin={isAdmin}
          />
        </>
      }
    />
  );
}
