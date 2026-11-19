import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { DeletePoolDocument, PoolDocument, UsageByPoolDocument } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { DetailTabBar, DetailTabPanel, DetailTabs, useDetailTab } from '@/components/detail-tabs';
import { LoadError, LoadState, RowSkeleton } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { ArrowLeft, Pencil } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { AFFINITIES, PoolDialog, STRATEGIES } from '@/models/pool-dialog';
import { PoolTargetsSection } from '@/models/pool-targets-section';
import { POOL_TABS, type PoolTab } from '@/models/tabs';
import { UsageSection } from '@/models/usage-section';

/** What each tab is called. */
const TAB_LABELS = {
  overview: 'Overview',
  targets: 'Targets',
  usage: 'Usage',
} as const satisfies Record<PoolTab, string>;

/**
 * What the calls naming one pool used, by the target each went to and by day. Asked for only once its tab is open.
 *
 * @param props - The pool's id.
 * @returns The usage section, or its loading and failed states.
 */
function PoolUsage({ poolId }: { poolId: string }) {
  const usage = useQuery({
    queryKey: ['usage', 'pool', poolId],
    queryFn: () => request(UsageByPoolDocument, { poolId }),
  });
  if (usage.isError) {
    return <LoadError error={usage.error} onRetry={usage.refetch} what="its usage" />;
  }
  if (usage.isPending) {
    return <RowSkeleton rows={3} />;
  }
  return (
    <UsageSection
      rows={usage.data.usageCounts}
      groupBy={(row) => `${row.providerName}/${row.model}`}
      groupLabel="Target"
    />
  );
}

/** One pool, in tabs: how it picks a target, its targets with their load, and what its calls used. */
export function PoolRoute() {
  const { poolId } = useParams({ from: '/app/pools/$poolId' });
  const navigate = useNavigate({ from: '/pools/$poolId' });
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const pool = useQuery({ queryKey: ['pools', poolId], queryFn: () => request(PoolDocument, { id: poolId }) });
  const remove = useMutation({
    mutationFn: () => request(DeletePoolDocument, { id: poolId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['pools'] });
      void navigate({ to: '/pools' });
    },
  });
  const record = pool.data?.pool ?? undefined;
  const { tab, showTab } = useDetailTab(POOL_TABS);
  const back = (
    <Button variant="outline" size="sm" iconSlot={<ArrowLeft />} linkSlot={<Link to="/pools" />} content="Pools" />
  );

  if (record === undefined) {
    return (
      <PageLayout
        title="Pool"
        backSlot={back}
        width="page"
        loading={pool.isPending}
        contentSlot={
          <LoadState query={pool} what="this pool" record={record} notFoundLabel="Pool not found" level={2} />
        }
      />
    );
  }

  return (
    <DetailTabs value={tab} onValueChange={showTab}>
      <PageLayout
        title={
          <span className="flex items-center gap-2">
            {record.displayName ?? record.name}
            {record.enabled ? null : <Badge variant="outline">Off</Badge>}
          </span>
        }
        description={record.description === '' ? undefined : record.description}
        backSlot={back}
        width="page"
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
        headerBarSlot={
          <DetailTabBar
            tabs={POOL_TABS}
            labels={TAB_LABELS}
            label="Pool"
            trailing={{ targets: <Badge variant="secondary">{record.targets.length}</Badge> }}
          />
        }
        contentSlot={
          <>
            <DetailTabPanel value="overview">
              <PropertyList
                contentSlot={
                  <>
                    <PropertyRow
                      label="Name"
                      value={record.name}
                      valueClassName="font-mono"
                      hint="What an agent names as its model."
                      actionSlot={<CopyButton value={record.name} label="Copy name" />}
                    />
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
                    <PropertyRow
                      label="Price"
                      value={
                        record.inputPricePerMillion === null || record.outputPricePerMillion === null
                          ? "Its targets' own"
                          : `${record.inputPricePerMillion} in, ${record.outputPricePerMillion} out per million tokens`
                      }
                    />
                    <PropertyRow label="Takes calls" value={record.enabled ? 'Yes' : 'No'} />
                  </>
                }
              />
            </DetailTabPanel>
            <DetailTabPanel value="targets">
              <PoolTargetsSection pool={record} providers={pool.data?.providers ?? []} />
            </DetailTabPanel>
            <DetailTabPanel value="usage">
              <PoolUsage poolId={record.id} />
            </DetailTabPanel>
            <PoolDialog open={isEditing} onOpenChange={setIsEditing} pool={record} />
          </>
        }
      />
    </DetailTabs>
  );
}
