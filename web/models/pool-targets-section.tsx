import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { type PoolFieldsFragment, PoolLoadDocument, type PoolLoadQuery } from '@/__generated__/graphql';
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

/** One target's entry in a pool's load. */
type TargetLoad = PoolLoadQuery['poolLoad'][number];

/**
 * Says what the router last learned of a target's health, under its name.
 *
 * @param load - The target's entry in the pool's load; undefined before it has arrived.
 * @returns Why it is passed over, while it is; else when a check last found it up; else nothing.
 */
function healthLine(load: TargetLoad | undefined): string | undefined {
  const downReason = load?.downReason ?? null;
  const checkedAt = load?.checkedAt ?? null;
  if (downReason !== null) {
    return downReason;
  }
  return checkedAt === null ? undefined : `Up at the last check, ${new Date(checkedAt).toLocaleTimeString()}.`;
}

/** What the targets section is given. */
export interface PoolTargetsSectionProps {
  pool: PoolFieldsFragment;
  /** Every provider a target may name. */
  providers: readonly { id: string; name: string }[];
}

/**
 * A pool's targets in the order it tries them, with each one's weight, the calls it has in flight now and its
 * health, and the dialog that edits them. Untitled: it is the Targets tab's whole pane, and the tab names it.
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
      description="Where its calls go, each taking a share of them by its weight, with how many each has in flight now. The router checks each target's provider in the background: one that is down, or that a call could not reach, is passed over and its calls go to the next."
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
                    description={healthLine(targetLoad)}
                    linkSlot={
                      target.provider === null || target.provider === undefined ? undefined : (
                        <Link to="/providers/$providerId" params={{ providerId: target.provider.id }} />
                      )
                    }
                    meta={
                      <span className="flex items-center gap-2">
                        {target.provider?.enabled === false ? <Badge variant="outline">Provider off</Badge> : null}
                        {targetLoad?.reachable === false ? (
                          <Badge variant="warning-soft">Down, passed over</Badge>
                        ) : null}
                        <span className="text-foreground/60 text-xs tabular-nums">Weight {target.weight}</span>
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
