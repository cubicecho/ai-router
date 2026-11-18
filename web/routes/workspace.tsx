import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import {
  DeleteWorkspaceDocument,
  MeDocument,
  RevokeWorkspaceKeyDocument,
  UsageByWorkspaceDocument,
  WorkspaceDocument,
} from '@/__generated__/graphql';
import { WorkspaceAgentsSection } from '@/agents/workspace-agents-section';
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
import { Role } from '@/lib/roles';
import { UsageSection } from '@/models/usage-section';
import { RecentRunsSection } from '@/runs/recent-runs-section';
import { WorkspaceServersSection } from '@/tools/workspace-servers-section';
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

/** One workspace: the agents its apps may run, the keys they call with, and how their runs use servers. */
export function WorkspaceRoute() {
  const { workspaceId } = useParams({ from: '/app/workspaces/$workspaceId' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [isMakingKey, setIsMakingKey] = useState(false);
  const me = useQuery({ queryKey: ['me'], queryFn: () => request(MeDocument) });
  const workspace = useQuery({
    queryKey: ['workspaces', workspaceId],
    queryFn: () => request(WorkspaceDocument, { id: workspaceId }),
  });
  const usage = useQuery({
    queryKey: ['usage', 'workspace', workspaceId],
    queryFn: () => request(UsageByWorkspaceDocument, { workspaceId }),
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
          <WorkspaceAgentsSection workspaceId={record.id} />
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
          <WorkspaceServersSection workspaceId={record.id} isAdmin={me.data?.me.role === Role.Admin} />
          <RecentRunsSection
            where={{ workspaceId: { eq: record.id } }}
            search={{ workspace: record.id }}
            hide="workspace"
          />
          <UsageSection
            rows={usage.data?.usageCounts ?? []}
            groupBy={(row) => `${row.providerName}/${row.model}`}
            groupLabel="Model"
          />
          <WorkspaceDialog open={isEditing} onOpenChange={setIsEditing} workspace={record} />
          <KeyDialog open={isMakingKey} onOpenChange={setIsMakingKey} workspaceId={record.id} />
        </>
      }
    />
  );
}
