import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { DeleteWorkspaceDocument, RevokeWorkspaceKeyDocument, WorkspaceDocument } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Pencil, Plus } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { KeyDialog } from '@/workspaces/key-dialog';
import { WorkspaceDialog } from '@/workspaces/workspace-dialog';

/**
 * Formats a timestamp as a date.
 *
 * @param iso - An ISO timestamp.
 * @returns The date in the reader's locale.
 */
function dateOf(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/** One workspace: what it is, and the keys its apps call with. */
export function WorkspaceRoute() {
  const { workspaceId } = useParams({ from: '/app/workspaces/$workspaceId' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [isMakingKey, setIsMakingKey] = useState(false);
  const workspace = useQuery({
    queryKey: ['workspaces', workspaceId],
    queryFn: () => request(WorkspaceDocument, { id: workspaceId }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['workspaces'] });
  const revoke = useMutation({
    mutationFn: (id: string) => request(RevokeWorkspaceKeyDocument, { id }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => request(DeleteWorkspaceDocument, { id: workspaceId }),
    onSuccess: async () => {
      await refresh();
      void navigate({ to: '/workspaces' });
    },
  });
  const record = workspace.data?.workspace ?? undefined;
  const back = (
    <Button
      variant="outline"
      size="sm"
      iconSlot={<ArrowLeft />}
      linkSlot={<Link to="/workspaces" />}
      content="Workspaces"
    />
  );

  if (record === undefined) {
    return (
      <PageLayout
        title="Workspace"
        backSlot={back}
        loading={workspace.isPending}
        contentSlot={
          <LoadState
            query={workspace}
            what="this workspace"
            record={record}
            notFoundLabel="Workspace not found"
            level={2}
          />
        }
      />
    );
  }

  const makeKey = (
    <Button variant="info" size="sm" iconSlot={<Plus />} onClick={() => setIsMakingKey(true)} content="New key" />
  );
  return (
    <PageLayout
      title={record.name}
      description={record.description === '' ? record.slug : record.description}
      backSlot={back}
      width="prose"
      actionSlot={
        <>
          <Button variant="outline" iconSlot={<Pencil />} onClick={() => setIsEditing(true)} content="Edit" />
          <ConfirmButton
            title={`Delete ${record.name}?`}
            description="Its keys stop working at once, and every app using them is refused."
            requireText={record.slug}
            onConfirm={() => remove.mutate()}
            content="Delete"
          />
        </>
      }
      contentSlot={
        <>
          <Section
            title="Keys"
            description="Each app sends one with every request. A key sees this workspace and nothing else."
            actionSlot={record.keys.length > 0 ? makeKey : undefined}
            contentSlot={
              record.keys.length === 0 ? (
                <EmptyState compact title="No keys yet. Make one for each app or device." actionSlot={makeKey} />
              ) : (
                <List
                  label="Keys"
                  contentSlot={record.keys.map((key) => (
                    <ListItem
                      key={key.id}
                      title={key.name}
                      description={`${key.start}…`}
                      meta={
                        key.expiresAt === null ? `Made ${dateOf(key.createdAt)}` : `Expires ${dateOf(key.expiresAt)}`
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
              )
            }
          />
          <WorkspaceDialog open={isEditing} onOpenChange={setIsEditing} workspace={record} />
          <KeyDialog open={isMakingKey} onOpenChange={setIsMakingKey} workspaceId={record.id} />
        </>
      }
    />
  );
}
