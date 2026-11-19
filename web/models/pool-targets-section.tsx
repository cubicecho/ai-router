import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { type PoolFieldsFragment, PoolLoadDocument } from '@/__generated__/graphql';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Pencil } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { TargetsDialog } from './targets-dialog';

/** How often the load per target is read again while the targets are shown. */
const LOAD_REFRESH_MS = 3_000;

/** What the targets section is given. */
export interface PoolTargetsSectionProps {
  pool: PoolFieldsFragment;
  /** Every provider a target may name. */
  providers: readonly { id: string; name: string }[];
}

/**
 * A pool's targets in the order it tries them, with the calls each has in flight now, and the dialog that edits
 * them. Untitled: it is the Targets tab's whole pane, and the tab names it.
 */
export function PoolTargetsSection({ pool, providers }: PoolTargetsSectionProps) {
  const [isEditing, setIsEditing] = useState(false);
  const load = useQuery({
    queryKey: ['pools', pool.id, 'load'],
    queryFn: () => request(PoolLoadDocument, { id: pool.id }),
    refetchInterval: LOAD_REFRESH_MS,
    meta: { quiet: true },
  });
  const loadOf = (providerId: string, model: string) =>
    load.data?.poolLoad.find((entry) => entry.providerId === providerId && entry.model === model);
  const edit = (
    <Button
      variant="outline"
      size="sm"
      iconSlot={<Pencil />}
      onClick={() => setIsEditing(true)}
      content="Edit targets"
    />
  );

  return (
    <Section
      description="Where its calls go, with how many each has in flight now. One that can't be reached is passed over for a while, and its calls go to the next."
      actionSlot={pool.targets.length > 0 ? edit : undefined}
      contentSlot={
        <>
          {pool.targets.length === 0 ? (
            <EmptyState compact title="No targets yet, so agents naming it are refused." actionSlot={edit} />
          ) : (
            <List
              label="Targets"
              contentSlot={pool.targets.map((target) => {
                const targetLoad = loadOf(target.provider?.id ?? '', target.model);
                return (
                  <ListItem
                    key={target.id}
                    title={`${target.provider?.name ?? '?'}/${target.model}`}
                    titleClassName="font-mono"
                    linkSlot={
                      target.provider === null || target.provider === undefined ? undefined : (
                        <Link to="/providers/$providerId" params={{ providerId: target.provider.id }} />
                      )
                    }
                    meta={
                      <span className="flex items-center gap-2">
                        {target.provider?.enabled === false ? <Badge variant="outline">Provider off</Badge> : null}
                        {targetLoad?.reachable === false ? (
                          <Badge variant="warning-soft">Unreachable, passed over</Badge>
                        ) : null}
                        <span className="text-foreground/60 text-xs tabular-nums">
                          {targetLoad?.inFlight ?? 0} in flight
                        </span>
                      </span>
                    }
                  />
                );
              })}
            />
          )}
          <TargetsDialog
            key={pool.targets.map((target) => target.id).join()}
            open={isEditing}
            onOpenChange={setIsEditing}
            pool={pool}
            providers={providers}
          />
        </>
      }
    />
  );
}
