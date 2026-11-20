import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ProvidersDocument } from '@/__generated__/graphql';
import { CardLayout } from '@/components/card-layout';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
import { RowMeta, rowNameFact } from '@/components/row-meta';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Plus, Server } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { ProviderDialog } from '@/models/provider-dialog';

/** Every model server the router's agents may call. */
export function ProvidersRoute() {
  const [isAdding, setIsAdding] = useState(false);
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => request(ProvidersDocument) });
  const rows = providers.data?.providers ?? [];
  const add = (
    <Button variant="positive" iconSlot={<Plus />} onClick={() => setIsAdding(true)} content="New provider" />
  );

  return (
    <PageLayout
      width="page"
      title="Providers"
      description="The model servers agents call. An agent names a model as <provider>/<model>."
      actionSlot={rows.length > 0 ? add : undefined}
      contentSlot={
        <>
          <LoadState
            query={providers}
            what="the providers"
            count={rows.length}
            emptySlot={
              <EmptyState
                iconSlot={<Server />}
                title="No providers yet"
                description="Add Ollama, llama.cpp, OpenAI or any other server that speaks OpenAI's API."
                actionSlot={add}
              />
            }
          />
          {rows.length > 0 ? (
            <CardLayout
              level={2}
              title="All providers"
              contentSlot={
                <List
                  label="Providers"
                  contentSlot={rows.map((provider) => (
                    <ListItem
                      key={provider.id}
                      title={provider.displayName ?? provider.name}
                      description={provider.baseUrl}
                      meta={
                        <RowMeta
                          facts={[rowNameFact(provider.displayName, provider.name)]}
                          badgesSlot={
                            <>
                              {provider.apiKeySet ? <Badge variant="positive-soft">Key set</Badge> : null}
                              {provider.enabled ? null : <Badge variant="outline">Off</Badge>}
                            </>
                          }
                        />
                      }
                      linkSlot={<Link to="/providers/$providerId" params={{ providerId: provider.id }} />}
                    />
                  ))}
                />
              }
            />
          ) : null}
          <ProviderDialog open={isAdding} onOpenChange={setIsAdding} provider={null} />
        </>
      }
    />
  );
}
