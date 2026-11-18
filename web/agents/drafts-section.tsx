import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type AgentRevisionFieldsFragment,
  DiscardRevisionDocument,
  PromoteRevisionDocument,
  SetAgentAutoPromoteDocument,
} from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { Check, Eye, Trash2 } from '@/components/ui/icons';
import { SwitchField } from '@/components/ui/switch-field';
import { useToast } from '@/components/ui/toast';
import { request } from '@/lib/gql';
import { RevisionDialog } from './revision-dialog';
import { whoOf } from './revisions';
import { whenOf } from './shapes';

/** What the drafts section is given. */
export interface DraftsSectionProps {
  /** The agent's id. */
  agentId: string;
  /** Whether a run's saves of it go live without review. */
  autoPromote: boolean;
  /** Its drafts, newest first. */
  drafts: readonly AgentRevisionFieldsFragment[];
}

/**
 * Says what a draft is and who it came from.
 *
 * @param draft - The draft.
 * @returns Its message, who saved it and when, and the revision it started from.
 */
function describeDraft(draft: AgentRevisionFieldsFragment): string {
  const said = `${whoOf(draft)}, ${whenOf(draft.createdAt)}`;
  const parts = [draft.message, said, draft.basedOn === null ? '' : `from revision ${draft.basedOn.number}`];
  return parts.filter((part) => part !== '').join(' · ');
}

/** An agent's drafts, waiting for a person to make one live or discard it, and whether runs' saves skip the wait. */
export function DraftsSection({ agentId, autoPromote, drafts }: DraftsSectionProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [viewing, setViewing] = useState<AgentRevisionFieldsFragment | null>(null);
  const promote = useMutation({
    mutationFn: (draft: AgentRevisionFieldsFragment) => request(PromoteRevisionDocument, { id: draft.id }),
    onSuccess: async (_answer, draft) => {
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      toast(`Revision ${draft.number} is live. Runs use it from their next request.`, 'positive');
    },
  });
  const discard = useMutation({
    mutationFn: (draft: AgentRevisionFieldsFragment) => request(DiscardRevisionDocument, { id: draft.id }),
    onSuccess: async (_answer, draft) => {
      await queryClient.invalidateQueries({ queryKey: ['agents', agentId] });
      toast(`Draft ${draft.number} is discarded.`, 'positive');
    },
  });
  const setAutoPromote = useMutation({
    mutationFn: (value: boolean) => request(SetAgentAutoPromoteDocument, { id: agentId, autoPromote: value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents', agentId] }),
  });
  const isBusy = promote.isPending || discard.isPending;

  return (
    <Section
      title="Drafts"
      description="Revisions an agent's run saved, waiting for a person to promote or discard them."
      contentSlot={
        <>
          <SwitchField
            id="auto-promote"
            label="Auto-promote"
            description="On, a run's save of this agent goes live at once, without anyone reviewing it. Drafts already here stay drafts, and a person's save always goes live."
            checked={setAutoPromote.isPending ? (setAutoPromote.variables ?? autoPromote) : autoPromote}
            onCheckedChange={(value) => setAutoPromote.mutate(value)}
            disabled={setAutoPromote.isPending}
          />
          {drafts.length === 0 ? (
            <EmptyState compact title="No drafts. When an agent's run saves this agent, its draft waits here." />
          ) : (
            <List
              label="Drafts"
              contentSlot={drafts.map((draft) => (
                <ListItem
                  key={draft.id}
                  title={`Revision ${draft.number}`}
                  description={describeDraft(draft)}
                  actionSlot={
                    <>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label={`View revision ${draft.number}`}
                        iconSlot={<Eye />}
                        onClick={() => setViewing(draft)}
                      />
                      <ConfirmButton
                        size="icon-sm"
                        aria-label={`Discard revision ${draft.number}`}
                        iconSlot={<Trash2 />}
                        disabled={isBusy}
                        title={`Discard revision ${draft.number}?`}
                        description="The draft is deleted and leaves no trace in the history. The live revision is unchanged."
                        confirmLabel="Discard"
                        onConfirm={() => discard.mutate(draft)}
                      />
                      <Button
                        variant="positive"
                        size="sm"
                        iconSlot={<Check />}
                        loading={promote.isPending && promote.variables?.id === draft.id}
                        disabled={isBusy}
                        hint="Makes it live. Runs use it from their next request, and the revision it replaces stays in the history."
                        onClick={() => promote.mutate(draft)}
                        content="Promote"
                      />
                    </>
                  }
                />
              ))}
            />
          )}
          {viewing === null ? null : (
            <RevisionDialog
              key={viewing.id}
              open
              onOpenChange={(open) => (open ? undefined : setViewing(null))}
              revision={viewing}
            />
          )}
        </>
      }
    />
  );
}
