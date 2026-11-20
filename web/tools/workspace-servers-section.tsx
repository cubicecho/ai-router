import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import {
  DeleteWorkspaceServerDocument,
  type WorkspaceServerFieldsFragment,
  WorkspaceServersDocument,
} from '@/__generated__/graphql';
import { CardLayout } from '@/components/card-layout';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { RowMeta, rowNameFact } from '@/components/row-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KeyRound, Pencil, Plus } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { describeRoles, rolesOf } from './admin-roles';
import { SecretDialog, type SecretKind } from './secret-dialog';
import { envOf, isBuiltin, STDIO, stringsOf, transportOf } from './shapes';
import { WorkspaceServerDialog } from './workspace-server-dialog';

/** What the section is given. */
export interface WorkspaceServersSectionProps {
  workspaceId: string;
  isAdmin: boolean;
}

/** A secret override being set: on which entry's server, and which secret. */
interface SecretTarget {
  serverId: string;
  serverName: string;
  kind: SecretKind;
}

/**
 * Says what an entry overrides, or for the admin server what it grants, in a few words.
 *
 * @param entry - The entry.
 * @param secrets - The names of its secret overrides.
 * @returns Such as "2 env vars, arguments, secrets: API_KEY", or "Roles: Read agents, Read runs".
 */
function overridesOf(entry: WorkspaceServerFieldsFragment, secrets: readonly string[]): string {
  if (isBuiltin(entry.server?.transport)) {
    return describeRoles(rolesOf(entry.roles));
  }
  const parts: string[] = [];
  const envCount = Object.keys(envOf(entry.env)).length;
  if (envCount > 0) {
    parts.push(envCount === 1 ? '1 env var' : `${envCount} env vars`);
  }
  if (entry.args !== null && entry.args !== undefined && stringsOf(entry.args).length > 0) {
    parts.push('arguments');
  }
  if (entry.url !== null && entry.url !== undefined) {
    parts.push(`address ${entry.url}`);
  }
  if (secrets.length > 0) {
    parts.push(`secrets: ${secrets.join(', ')}`);
  }
  return parts.length === 0 ? 'Overrides nothing yet' : parts.join(', ');
}

/**
 * A workspace's entries for servers: the settings its agent runs use in place of each server's own. Untitled: its
 * tab names it.
 */
export function WorkspaceServersSection({ workspaceId, isAdmin }: WorkspaceServersSectionProps) {
  const queryClient = useQueryClient();
  // undefined is closed, null is adding, an entry is editing it.
  const [editing, setEditing] = useState<WorkspaceServerFieldsFragment | null | undefined>(undefined);
  const [secretTarget, setSecretTarget] = useState<SecretTarget | null>(null);
  const entries = useQuery({
    queryKey: ['workspaces', workspaceId, 'servers'],
    queryFn: () => request(WorkspaceServersDocument, { workspaceId }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => request(DeleteWorkspaceServerDocument, { id }),
    // The whole prefix: the workspaces list counts each one's entries too.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
  });
  const rows = entries.data?.workspaceServers ?? [];
  const servers = entries.data?.servers ?? [];
  const secretsOf = (serverId: string) =>
    (entries.data?.serverSecrets ?? []).filter((secret) => secret.serverId === serverId).map((secret) => secret.name);
  const add = (
    <Button variant="positive" size="sm" iconSlot={<Plus />} onClick={() => setEditing(null)} content="Add server" />
  );

  return (
    <CardLayout
      level={2}
      description="An entry sets a server's settings for this workspace's agent runs, such as an account's login. It never adds the server to a run."
      actionSlot={rows.length > 0 ? add : undefined}
      contentSlot={
        <>
          <LoadState
            compact
            query={entries}
            what="its MCP Servers"
            count={rows.length}
            emptySlot={
              <EmptyState compact title="No entries yet, so runs here use each MCP Server as it is." actionSlot={add} />
            }
          />
          <List
            label="MCP Servers"
            contentSlot={rows.map((entry) => {
              const name = entry.server?.name ?? 'A deleted server';
              const kind: SecretKind =
                entry.server === null ||
                entry.server === undefined ||
                transportOf(entry.server.transport).type === STDIO
                  ? 'env'
                  : 'header';
              const isBuiltinServer = isBuiltin(entry.server?.transport);
              return (
                <ListItem
                  key={entry.id}
                  title={entry.server?.displayName ?? name}
                  description={overridesOf(entry, secretsOf(entry.serverId))}
                  meta={
                    <RowMeta
                      facts={[
                        entry.server === null || entry.server === undefined
                          ? null
                          : rowNameFact(entry.server.displayName, name),
                      ]}
                      badgesSlot={isBuiltinServer ? <Badge variant="secondary">Built in</Badge> : null}
                    />
                  }
                  linkSlot={
                    entry.server === null || entry.server === undefined ? undefined : (
                      <Link to="/mcp-servers/$serverId" params={{ serverId: entry.serverId }} />
                    )
                  }
                  actionSlot={
                    <>
                      {isAdmin && isBuiltinServer === false ? (
                        <Button
                          variant="outline"
                          size="icon-sm"
                          aria-label={`Set a secret for ${name} here`}
                          iconSlot={<KeyRound />}
                          onClick={() => setSecretTarget({ serverId: entry.serverId, serverName: name, kind })}
                        />
                      ) : null}
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label={`Edit ${name} here`}
                        iconSlot={<Pencil />}
                        onClick={() => setEditing(entry)}
                      />
                      <ConfirmButton
                        size="sm"
                        title={`Remove ${name} from this workspace?`}
                        description="Runs here use the server's own settings again. Its secret overrides here are kept."
                        confirmLabel="Remove"
                        onConfirm={() => remove.mutate(entry.id)}
                        content="Remove"
                      />
                    </>
                  }
                />
              );
            })}
          />
          {editing === undefined ? null : (
            <WorkspaceServerDialog
              key={editing?.id ?? 'new'}
              open
              onOpenChange={(open) => (open ? undefined : setEditing(undefined))}
              workspaceId={workspaceId}
              entry={editing}
              servers={servers}
              taken={rows.map((row) => row.serverId)}
            />
          )}
          {isAdmin && secretTarget !== null ? (
            <SecretDialog
              key={secretTarget.serverId}
              open
              onOpenChange={(open) => (open ? undefined : setSecretTarget(null))}
              serverId={secretTarget.serverId}
              serverName={secretTarget.serverName}
              workspaceId={workspaceId}
              target={{ kind: secretTarget.kind, name: '', isSet: false }}
            />
          ) : null}
        </>
      }
    />
  );
}
