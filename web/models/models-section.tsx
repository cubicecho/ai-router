import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { ProviderModelsDocument } from '@/__generated__/graphql';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadError, RowSkeleton } from '@/components/load-state';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { RefreshCw } from '@/components/ui/icons';
import { request } from '@/lib/gql';

/** What the models section is given. */
export interface ModelsSectionProps {
  providerId: string;
  /** The provider's name, which an agent puts before each model. */
  providerName: string;
}

/**
 * What a provider serves now, asked of its own model list, each as an agent names it. Untitled: it is the Models
 * tab's whole pane, and the tab names it.
 */
export function ModelsSection({ providerId, providerName }: ModelsSectionProps) {
  // A ref, not state: Refresh refetches in the same click, before a render could hand the query a new function.
  const refresh = useRef(false);
  const models = useQuery({
    queryKey: ['providers', providerId, 'models'],
    queryFn: () => request(ProviderModelsDocument, { id: providerId, refresh: refresh.current }),
    meta: { quiet: true },
  });
  const rows = models.data?.providerModels ?? [];

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
          return (
            <ListItem
              key={model.id}
              title={modelId}
              titleClassName="font-mono"
              meta={model.ownedBy ?? undefined}
              actionSlot={<CopyButton value={modelId} label={`Copy ${modelId}`} />}
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
      contentSlot={body()}
    />
  );
}
