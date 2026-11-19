import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type KeyFieldsFragment, RevokeWorkspaceKeyDocument } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KeyRound, Plus } from '@/components/ui/icons';
import { formatDate } from '@/lib/format';
import { request } from '@/lib/gql';
import { KeyDialog } from './key-dialog';

/** What the section is given. */
export interface WorkspaceKeysSectionProps {
  workspaceId: string;
  /** The workspace's keys, newest first, as its own query answered. */
  keys: readonly KeyFieldsFragment[];
}

/**
 * Says when a key was made, and by whom.
 *
 * @param key - The key.
 * @returns Such as "Made 18/11/2026 by Ben".
 */
function madeOf(key: KeyFieldsFragment): string {
  const by = key.creator?.name ?? key.creator?.email;
  return by === undefined ? `Made ${formatDate(key.createdAt)}` : `Made ${formatDate(key.createdAt)} by ${by}`;
}

/**
 * Says when a key stops working, if it ever does.
 *
 * @param expiresAt - When it expires, or null for never.
 * @param now - The time to compare with, in milliseconds since the epoch.
 * @returns An "Expired" or "Expires …" badge, or null for a key that never expires.
 */
function expiryOf(expiresAt: string | null, now: number) {
  if (expiresAt === null) {
    return null;
  }
  const hasExpired = Date.parse(expiresAt) <= now;
  if (hasExpired) {
    return <Badge variant="destructive-soft">Expired</Badge>;
  }
  return <Badge variant="secondary">Expires {formatDate(expiresAt)}</Badge>;
}

/** The keys a workspace's apps call with: one per app or device, each revoked on its own. Untitled: its tab names it. */
export function WorkspaceKeysSection({ workspaceId, keys }: WorkspaceKeysSectionProps) {
  const queryClient = useQueryClient();
  const [isMakingKey, setIsMakingKey] = useState(false);
  const revoke = useMutation({
    mutationFn: (id: string) => request(RevokeWorkspaceKeyDocument, { id }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
  });
  const now = Date.now();
  const makeKey = (
    <Button variant="positive" size="sm" iconSlot={<Plus />} onClick={() => setIsMakingKey(true)} content="New key" />
  );

  return (
    <Section
      description="Each app sends one with every request. A key sees this workspace and nothing else."
      actionSlot={keys.length > 0 ? makeKey : undefined}
      contentSlot={
        <>
          {keys.length === 0 ? (
            <EmptyState
              iconSlot={<KeyRound />}
              title="No keys yet"
              description="Make one for each app or device, so each can be revoked on its own."
              actionSlot={makeKey}
            />
          ) : (
            <List
              label="Keys"
              contentSlot={keys.map((key) => (
                <ListItem
                  key={key.id}
                  title={key.name}
                  description={madeOf(key)}
                  meta={
                    <span className="flex items-center gap-2 text-foreground/60 text-xs">
                      <span className="font-mono">{key.start}…</span>
                      {expiryOf(key.expiresAt, now)}
                    </span>
                  }
                  actionSlot={
                    <ConfirmButton
                      size="sm"
                      title={`Revoke ${key.name}?`}
                      description="An app using this key is refused from its next request."
                      confirmLabel="Revoke"
                      onConfirm={() => revoke.mutate(key.id)}
                      content="Revoke"
                    />
                  }
                />
              ))}
            />
          )}
          <KeyDialog open={isMakingKey} onOpenChange={setIsMakingKey} workspaceId={workspaceId} />
        </>
      }
    />
  );
}
