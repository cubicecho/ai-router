import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { DeletePoolDocument, PoolDocument, PoolLoadDocument } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Pencil } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { AFFINITIES, PoolDialog, STRATEGIES } from '@/models/pool-dialog';
import { TargetsDialog } from '@/models/targets-dialog';

/** How often the load per target is read again while the page is open. */
const LOAD_REFRESH_MS = 3_000;

/** One pool: how it picks, and its targets with their load. */
export function PoolRoute() {
  const { poolId } = useParams({ from: '/app/pools/$poolId' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [isEditingTargets, setIsEditingTargets] = useState(false);
  const pool = useQuery({ queryKey: ['pools', poolId], queryFn: () => request(PoolDocument, { id: poolId }) });
  const load = useQuery({
    queryKey: ['pools', poolId, 'load'],
    queryFn: () => request(PoolLoadDocument, { id: poolId }),
    refetchInterval: LOAD_REFRESH_MS,
    meta: { quiet: true },
  });
  const remove = useMutation({
    mutationFn: () => request(DeletePoolDocument, { id: poolId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['pools'] });
      void navigate({ to: '/pools' });
    },
  });
  const record = pool.data?.pool ?? undefined;
  const back = (
    <Button variant="outline" size="sm" iconSlot={<ArrowLeft />} linkSlot={<Link to="/pools" />} content="Pools" />
  );

  if (record === undefined) {
    return (
      <PageLayout
        title="Pool"
        backSlot={back}
        loading={pool.isPending}
        contentSlot={
          <LoadState query={pool} what="this pool" record={record} notFoundLabel="Pool not found" level={2} />
        }
      />
    );
  }

  const inFlight = (providerId: string, model: string) =>
    load.data?.poolLoad.find((entry) => entry.providerId === providerId && entry.model === model)?.inFlight ?? 0;
  const editTargets = (
    <Button
      variant="outline"
      size="sm"
      iconSlot={<Pencil />}
      onClick={() => setIsEditingTargets(true)}
      content="Edit targets"
    />
  );
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
            description="Agents naming it as their model are refused until they name another."
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
                <PropertyRow label="Name" value={<code>{record.name}</code>} hint="What an agent names as its model." />
                <PropertyRow
                  label="Picks a target"
                  value={STRATEGIES.find((strategy) => strategy.value === record.strategy)?.label}
                />
                <PropertyRow
                  label="Conversations"
                  value={AFFINITIES.find((affinity) => affinity.value === record.affinity)?.label}
                />
                <PropertyRow
                  label="Load factor"
                  value={record.maxLoadFactor === null ? 'Off' : String(record.maxLoadFactor)}
                />
                <PropertyRow label="Takes calls" value={record.enabled ? 'Yes' : 'No'} />
              </>
            }
          />
          <Section
            title="Targets"
            description="Where its calls go, with how many each has in flight now."
            actionSlot={record.targets.length > 0 ? editTargets : undefined}
            contentSlot={
              record.targets.length === 0 ? (
                <EmptyState compact title="No targets yet, so agents naming it are refused." actionSlot={editTargets} />
              ) : (
                <List
                  label="Targets"
                  contentSlot={record.targets.map((target) => (
                    <ListItem
                      key={target.id}
                      title={`${target.provider?.name ?? '?'}/${target.model}`}
                      meta={
                        <span className="flex items-center gap-2">
                          {target.provider?.enabled === false ? <Badge variant="outline">Provider off</Badge> : null}
                          <span className="text-foreground/60 text-xs tabular-nums">
                            {inFlight(target.provider?.id ?? '', target.model)} in flight
                          </span>
                        </span>
                      }
                    />
                  ))}
                />
              )
            }
          />
          <PoolDialog open={isEditing} onOpenChange={setIsEditing} pool={record} />
          <TargetsDialog
            key={record.targets.map((target) => target.id).join()}
            open={isEditingTargets}
            onOpenChange={setIsEditingTargets}
            pool={record}
            providers={pool.data?.providers ?? []}
          />
        </>
      }
    />
  );
}
