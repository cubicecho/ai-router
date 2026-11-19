import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { DeletePoolDocument, PoolDocument } from '@/__generated__/graphql';
import { ConfirmButton } from '@/components/confirm-button';
import { LoadState } from '@/components/load-state';
import { PageLayout, titleColumn } from '@/components/page-layout';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { ArrowLeft, Pencil } from '@/components/ui/icons';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { request } from '@/lib/gql';
import { openTab } from '@/lib/tab-search';
import { cn } from '@/lib/utils';
import { AFFINITIES, PoolDialog, STRATEGIES } from '@/models/pool-dialog';
import { PoolTargetsSection } from '@/models/pool-targets-section';
import { POOL_TABS, type PoolTab, validatePoolSearch } from '@/models/tabs';

/** What each tab is called. */
const TAB_LABELS = {
  overview: 'Overview',
  targets: 'Targets',
} as const satisfies Record<PoolTab, string>;

/** One pool, in tabs: how it picks a target, and its targets with their load. */
export function PoolRoute() {
  const { poolId } = useParams({ from: '/app/pools/$poolId' });
  const search = useSearch({ from: '/app/pools/$poolId' });
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
    <Tabs
      value={openTab(POOL_TABS, search)}
      onValueChange={(tab) => void navigate({ search: validatePoolSearch({ tab }), replace: true })}
      className="h-full"
    >
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
          <div className={cn(titleColumn('page'), 'pb-3')}>
            <TabsList aria-label="Pool">
              {POOL_TABS.map((tab) => (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  trailingSlot={
                    tab === 'targets' ? <Badge variant="secondary">{record.targets.length}</Badge> : undefined
                  }
                >
                  {TAB_LABELS[tab]}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        }
        contentSlot={
          <>
            <TabsContent value="overview">
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
                    <PropertyRow label="Takes calls" value={record.enabled ? 'Yes' : 'No'} />
                  </>
                }
              />
            </TabsContent>
            <TabsContent value="targets">
              <PoolTargetsSection pool={record} providers={pool.data?.providers ?? []} />
            </TabsContent>
            <PoolDialog open={isEditing} onOpenChange={setIsEditing} pool={record} />
          </>
        }
      />
    </Tabs>
  );
}
