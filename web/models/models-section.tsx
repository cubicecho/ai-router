import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ModelPricesDocument, ProviderModelsDocument } from '@/__generated__/graphql';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadError, RowSkeleton } from '@/components/load-state';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { RefreshCw } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import type { Price } from './cost';
import { PriceDialog } from './price-dialog';

const PRICE = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });

/**
 * Writes a model's price for its row.
 *
 * @param price - The price.
 * @returns Both prices, per million tokens.
 */
function priceLine(price: Price): string {
  return `${PRICE.format(price.inputPerMillion)} in, ${PRICE.format(price.outputPerMillion)} out per million tokens`;
}

/** What the models section is given. */
export interface ModelsSectionProps {
  providerId: string;
  /** The provider's name, which an agent puts before each model. */
  providerName: string;
}

/**
 * What a provider serves now, asked of its own model list, each as an agent names it, with the price people gave
 * it. A priced model the list no longer has stays, so its price can be cleared. Untitled: it is the Models tab's
 * whole pane, and the tab names it.
 *
 * @param props - The provider.
 * @returns The section.
 */
export function ModelsSection({ providerId, providerName }: ModelsSectionProps) {
  // A ref, not state: Refresh refetches in the same click, before a render could hand the query a new function.
  const refresh = useRef(false);
  const models = useQuery({
    queryKey: ['providers', providerId, 'models'],
    queryFn: () => request(ProviderModelsDocument, { id: providerId, refresh: refresh.current }),
    meta: { quiet: true },
  });
  const prices = useQuery({
    queryKey: ['prices', 'provider', providerId],
    queryFn: () => request(ModelPricesDocument, { providerId }),
  });
  const [pricing, setPricing] = useState<string | null>(null);
  const priceOf = (model: string): Price | null =>
    prices.data?.modelPrices.find((price) => price.model === model) ?? null;
  const listed = models.data?.providerModels ?? [];
  const unlisted = (prices.data?.modelPrices ?? [])
    .filter((price) => listed.some((model) => model.id === price.model) === false)
    .map((price) => ({ id: price.model, ownedBy: null }));
  const rows = [...listed, ...unlisted];

  const body = () => {
    if (models.isError) {
      return <LoadError error={models.error} onRetry={models.refetch} what="its models" compact />;
    }
    if (models.isPending) {
      return <RowSkeleton rows={3} />;
    }
    if (rows.length === 0) {
      return <EmptyState compact title="It lists no models." />;
    }
    return (
      <List
        label="Models"
        contentSlot={rows.map((model) => {
          const modelId = `${providerName}/${model.id}`;
          const price = priceOf(model.id);
          return (
            <ListItem
              key={model.id}
              title={modelId}
              titleClassName="font-mono"
              description={price === null ? undefined : priceLine(price)}
              meta={model.ownedBy ?? undefined}
              actionSlot={
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPricing(model.id)}
                    content={price === null ? 'Set price' : 'Price'}
                  />
                  <CopyButton value={modelId} label={`Copy ${modelId}`} />
                </>
              }
            />
          );
        })}
      />
    );
  };

  return (
    <Section
      description="What it serves now, from its own model list. An agent names each one as it is written here."
      actionSlot={
        <Button
          variant="outline"
          size="sm"
          iconSlot={<RefreshCw />}
          loading={models.isFetching}
          onClick={() => {
            refresh.current = true;
            void models.refetch();
          }}
          content="Refresh"
        />
      }
      contentSlot={
        <>
          {body()}
          {pricing === null ? null : (
            <PriceDialog
              key={pricing}
              open
              onOpenChange={(open) => setPricing(open ? pricing : null)}
              providerId={providerId}
              modelId={`${providerName}/${pricing}`}
              model={pricing}
              price={priceOf(pricing)}
            />
          )}
        </>
      }
    />
  );
}
