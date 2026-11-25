import { useQueries, useQuery } from '@tanstack/react-query';
import { ModelChoicesDocument, ProviderModelsDocument } from '@/__generated__/graphql';
import { describeError } from '@/lib/error-message';
import { request } from '@/lib/gql';
import type { SelectEntry } from '@/lib/select-options';
import { modelOptionsOf } from './model-options';

/**
 * Reads the Model field's choices once its menu has been opened, so an editor nobody opens the menu of asks no
 * provider for anything. Each provider's list shares its cache with the provider's Models tab.
 *
 * @param isOpened - Whether the menu has been opened yet.
 * @returns The entries, with a note while the pools and providers themselves are read.
 */
export function useModelOptions(isOpened: boolean): SelectEntry[] {
  const choices = useQuery({
    queryKey: ['agents', 'model-choices'],
    queryFn: () => request(ModelChoicesDocument),
    enabled: isOpened,
  });
  const providers = choices.data?.providers ?? [];
  const listings = useQueries({
    queries: providers.map((provider) => ({
      queryKey: ['providers', provider.id, 'models'],
      queryFn: () => request(ProviderModelsDocument, { id: provider.id, refresh: false }),
      enabled: isOpened && provider.enabled,
      meta: { quiet: true },
    })),
  });

  if (choices.error !== null) {
    return [{ note: describeError(choices.error), className: 'text-negative' }];
  }
  if (choices.data === undefined) {
    return isOpened ? [{ note: 'Reading the pools and providers…' }] : [];
  }
  return modelOptionsOf(
    choices.data.pools,
    providers.map((provider, at) => {
      const listing = listings[at];
      return {
        name: provider.name,
        enabled: provider.enabled,
        models: listing?.data?.providerModels.map((model) => model.id),
        error: listing?.error ? describeError(listing.error) : undefined,
      };
    }),
  );
}
