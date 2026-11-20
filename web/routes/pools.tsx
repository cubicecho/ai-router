import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { PoolsDocument } from '@/__generated__/graphql';
import { CardLayout } from '@/components/card-layout';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { RowMeta, rowNameFact } from '@/components/row-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Layers, Plus } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { PoolDialog, STRATEGIES } from '@/models/pool-dialog';

/**
 * Says how many targets a pool has.
 *
 * @param count - The number of targets.
 * @returns "No targets", "1 target" or "3 targets".
 */
function targetCount(count: number): string {
  if (count === 0) {
    return 'No targets';
  }
  return count === 1 ? '1 target' : `${count} targets`;
}

/** Every pool: one model name served by several targets. */
export function PoolsRoute() {
  const [isCreating, setIsCreating] = useState(false);
  const pools = useQuery({ queryKey: ['pools'], queryFn: () => request(PoolsDocument) });
  const rows = pools.data?.pools ?? [];
  const create = (
    <Button variant="positive" iconSlot={<Plus />} onClick={() => setIsCreating(true)} content="New pool" />
  );

  return (
    <PageLayout
      width="page"
      title="Pools"
      description="One model name served by several targets. An agent names a pool as its model."
      actionSlot={rows.length > 0 ? create : undefined}
      contentSlot={
        <>
          <LoadState
            query={pools}
            what="the pools"
            count={rows.length}
            emptySlot={
              <EmptyState
                iconSlot={<Layers />}
                title="No pools yet"
                description="A pool spreads one model over several servers, and keeps a conversation on one of them."
                actionSlot={create}
              />
            }
          />
          {rows.length > 0 ? (
            <CardLayout
              level={2}
              title="All pools"
              contentSlot={
                <List
                  label="Pools"
                  contentSlot={rows.map((pool) => (
                    <ListItem
                      key={pool.id}
                      title={pool.displayName ?? pool.name}
                      description={STRATEGIES.find((strategy) => strategy.value === pool.strategy)?.label}
                      meta={
                        <RowMeta
                          facts={[rowNameFact(pool.displayName, pool.name), targetCount(pool.targets.length)]}
                          badgesSlot={pool.enabled ? null : <Badge variant="outline">Off</Badge>}
                        />
                      }
                      linkSlot={<Link to="/pools/$poolId" params={{ poolId: pool.id }} />}
                    />
                  ))}
                />
              }
            />
          ) : null}
          <PoolDialog open={isCreating} onOpenChange={setIsCreating} pool={null} />
        </>
      }
    />
  );
}
