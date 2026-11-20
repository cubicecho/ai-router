import { useState } from 'react';
import { CardLayout } from '@/components/card-layout';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { RowMeta } from '@/components/row-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KeyRound, Plus } from '@/components/ui/icons';
import { SecretDialog, type SecretKind, type SecretTarget } from './secret-dialog';
import { type EnvVarMeta, type ServerTransport, STDIO } from './shapes';

/** One secret as the server serves it: its name, never its value. */
export interface SecretName {
  kind: SecretKind;
  name: string;
}

/** One row of the section: a secret that is set, or one the registry says the server wants. */
interface SecretRow extends SecretTarget {
  meta: EnvVarMeta | undefined;
}

/** What the secrets section is given. */
export interface SecretsSectionProps {
  serverId: string;
  serverName: string;
  transport: ServerTransport;
  /** The secrets set on the server itself. */
  secrets: readonly SecretName[];
  /** What the registry said of each env var. */
  envMeta: Readonly<Record<string, EnvVarMeta>>;
  isAdmin: boolean;
}

/**
 * Lists the secrets set and the ones the server wants.
 *
 * @param secrets - The secrets set.
 * @param envMeta - What is known of each env var.
 * @returns Set ones first, by name, then the secret env vars nobody has set yet.
 */
function rowsOf(secrets: readonly SecretName[], envMeta: Readonly<Record<string, EnvVarMeta>>): SecretRow[] {
  const set: SecretRow[] = secrets.map((secret) => ({
    kind: secret.kind,
    name: secret.name,
    isSet: true,
    meta: secret.kind === 'env' ? envMeta[secret.name] : undefined,
  }));
  const missing: SecretRow[] = Object.entries(envMeta)
    .filter(
      ([name, meta]) => meta.isSecret === true && set.some((row) => row.kind === 'env' && row.name === name) === false,
    )
    .map(([name, meta]) => ({ kind: 'env', name, isSet: false, meta }));
  return [...set, ...missing];
}

/**
 * Whether the registry says the server needs a secret nobody has set.
 *
 * @param secrets - The secrets set.
 * @param envMeta - What is known of each env var.
 * @returns true when a required secret is missing.
 */
export function isRequiredSecretUnset(
  secrets: readonly SecretName[],
  envMeta: Readonly<Record<string, EnvVarMeta>>,
): boolean {
  return rowsOf(secrets, envMeta).some((row) => row.isSet === false && row.meta?.isRequired === true);
}

/**
 * A server's secrets: env values and headers kept by the router and never shown. Only an admin sets them. Untitled:
 * its tab names it.
 */
export function SecretsSection({ serverId, serverName, transport, secrets, envMeta, isAdmin }: SecretsSectionProps) {
  const [target, setTarget] = useState<SecretTarget | null>(null);
  const rows = rowsOf(secrets, envMeta);
  const kind: SecretKind = transport.type === STDIO ? 'env' : 'header';
  const add = isAdmin ? (
    <Button
      variant="positive"
      size="sm"
      iconSlot={<Plus />}
      onClick={() => setTarget({ kind, name: '', isSet: false })}
      content="Set secret"
    />
  ) : undefined;

  return (
    <CardLayout
      level={2}
      description={
        isAdmin
          ? 'Env values and headers the router keeps for it. Once saved a value is never shown again.'
          : 'Env values and headers the router keeps for it. Only an admin can set them.'
      }
      actionSlot={add}
      contentSlot={
        <>
          {rows.length === 0 ? (
            <EmptyState compact title="No secrets set." />
          ) : (
            <List
              label="Secrets"
              contentSlot={rows.map((row) => (
                <ListItem
                  key={`${row.kind}\n${row.name}`}
                  title={row.name}
                  titleClassName="font-mono"
                  description={row.meta?.description}
                  meta={
                    <RowMeta
                      facts={[row.kind === 'env' ? 'Env var' : 'Header']}
                      badgesSlot={
                        row.isSet ? (
                          <Badge variant="positive-soft">Set</Badge>
                        ) : (
                          <Badge variant={row.meta?.isRequired === true ? 'warning-soft' : 'outline'}>
                            {row.meta?.isRequired === true ? 'Required, not set' : 'Not set'}
                          </Badge>
                        )
                      }
                    />
                  }
                  actionSlot={
                    isAdmin ? (
                      <Button
                        variant="outline"
                        size="sm"
                        iconSlot={<KeyRound />}
                        onClick={() => setTarget(row)}
                        content={row.isSet ? 'Change' : 'Set'}
                      />
                    ) : undefined
                  }
                />
              ))}
            />
          )}
          {isAdmin && target !== null ? (
            <SecretDialog
              key={`${target.kind}\n${target.name}`}
              open
              onOpenChange={(open) => (open ? undefined : setTarget(null))}
              serverId={serverId}
              serverName={serverName}
              workspaceId={null}
              target={target}
            />
          ) : null}
        </>
      }
    />
  );
}
