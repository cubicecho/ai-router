import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { type AgentRevisionFieldsFragment, PromoteRevisionDocument } from '@/__generated__/graphql';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Eye, Undo2 } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { request } from '@/lib/gql';
import { RevisionDialog } from './revision-dialog';
import { RevisionStanding, standingOf, whoOf } from './revisions';
import { whenOf } from './shapes';

/** What the history is given. */
export interface HistorySectionProps {
  /** The live revision's id, or null when none is. */
  liveRevisionId: string | null;
  /** Every revision, newest first. */
  revisions: readonly AgentRevisionFieldsFragment[];
}

/** The badge for each standing. Retired was live once; a draft never has been. */
const STANDING_BADGES: Record<RevisionStanding, ReactNode> = {
  [RevisionStanding.Live]: <Badge variant="positive-soft">Live</Badge>,
  [RevisionStanding.Retired]: <Badge variant="secondary">Retired</Badge>,
  [RevisionStanding.Draft]: <Badge variant="info-soft">Draft</Badge>,
};

/** Every revision of an agent, newest first. A retired one can go live again; a draft is promoted from Drafts. */
export function HistorySection({ liveRevisionId, revisions }: HistorySectionProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [viewing, setViewing] = useState<AgentRevisionFieldsFragment | null>(null);
  const promote = useMutation({
    mutationFn: (revision: AgentRevisionFieldsFragment) => request(PromoteRevisionDocument, { id: revision.id }),
    onSuccess: async (_answer, revision) => {
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      toast(`Revision ${revision.number} is live. Runs use it from their next request.`, 'positive');
    },
  });
  const live = revisions.find((revision) => revision.id === liveRevisionId);

  return (
    <Section
      title="History"
      description="Every revision kept, drafts included. Making a retired one live again rolls the agent back; nothing is lost."
      contentSlot={
        <>
          <List
            label="Revisions"
            contentSlot={revisions.map((revision) => {
              const standing = standingOf(revision, liveRevisionId);
              const isOlder = live !== undefined && revision.number < live.number;
              const said = `${whoOf(revision)}, ${whenOf(revision.createdAt)}`;
              return (
                <ListItem
                  key={revision.id}
                  title={`Revision ${revision.number}`}
                  description={revision.message === '' ? said : `${revision.message} · ${said}`}
                  meta={STANDING_BADGES[standing]}
                  actionSlot={
                    standing === RevisionStanding.Live ? null : (
                      <>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          aria-label={`View revision ${revision.number}`}
                          iconSlot={<Eye />}
                          onClick={() => setViewing(revision)}
                        />
                        {standing === RevisionStanding.Draft ? null : (
                          <Button
                            variant="outline"
                            size="sm"
                            iconSlot={isOlder ? <Undo2 /> : undefined}
                            loading={promote.isPending && promote.variables?.id === revision.id}
                            disabled={promote.isPending}
                            hint={
                              isOlder
                                ? `Rolls the agent back from revision ${live.number}, which stays in the history.`
                                : 'Runs use it from their next request.'
                            }
                            onClick={() => promote.mutate(revision)}
                            content={isOlder ? 'Roll back to this' : 'Make live'}
                          />
                        )}
                      </>
                    )
                  }
                />
              );
            })}
          />
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
