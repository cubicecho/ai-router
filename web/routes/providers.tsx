import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { ProvidersDocument } from '@/__generated__/graphql';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { LoadState } from '@/components/load-state';
import { PageLayout } from '@/components/page-layout';
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
      width="full"
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
          <List
            label="Providers"
            contentSlot={rows.map((provider) => (
              <ListItem
                key={provider.id}
                title={provider.displayName ?? provider.name}
                description={
                  provider.displayName === null ? provider.baseUrl : `${provider.name} · ${provider.baseUrl}`
                }
                meta={
                  <span className="flex items-center gap-1">
                    {provider.enabled ? null : <Badge variant="outline">Off</Badge>}
                    {provider.apiKeySet ? <Badge variant="outline">Key set</Badge> : null}
                  </span>
                }
                linkSlot={<Link to="/providers/$providerId" params={{ providerId: provider.id }} />}
              />
            ))}
          />
          <ProviderDialog open={isAdding} onOpenChange={setIsAdding} provider={null} />
        </>
      }
    />
  );
}
