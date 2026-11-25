import type { SelectEntry } from '../lib/select-options';

/** The heading the pools are listed under. */
const POOLS_GROUP = 'Pools';
/** Model ids are identifiers, so their rows are in the code face. */
const ID_CLASS = 'font-mono';
/** What a turned-off pool says beside its name. */
const POOL_OFF_HINT = 'Turned off: an agent naming it can’t run until it is on.';

/** A pool, as the Model field offers it. */
export interface PoolChoice {
  name: string;
  enabled: boolean;
}

/** A provider and what it serves, as far as the editor has heard. */
export interface ProviderChoice {
  name: string;
  enabled: boolean;
  /** Its models' ids at the provider, or undefined while they are asked for. */
  models: readonly string[] | undefined;
  /** Why its list could not be read, or undefined. */
  error: string | undefined;
}

/**
 * Lists what an agent's document may name as its model: each pool by its name, then each provider's models as
 * `<provider>/<model>`, under the provider's name. A provider still answering, failing or turned off is a note in
 * its place, never a choice.
 *
 * @param pools - The pools, in the order to list them.
 * @param providers - The providers, in the order to list them.
 * @returns The Model field's entries.
 */
export function modelOptionsOf(pools: readonly PoolChoice[], providers: readonly ProviderChoice[]): SelectEntry[] {
  const poolEntries: SelectEntry[] = pools.map((pool) => ({
    value: pool.name,
    label: pool.name,
    group: POOLS_GROUP,
    className: ID_CLASS,
    hint: pool.enabled ? undefined : POOL_OFF_HINT,
  }));
  const providerEntries = providers.flatMap((provider): SelectEntry[] => {
    if (provider.enabled === false) {
      return [{ note: `${provider.name} is turned off, so its models aren’t listed.` }];
    }
    if (provider.error !== undefined) {
      return [{ note: `${provider.name}: ${provider.error}`, className: 'text-negative' }];
    }
    if (provider.models === undefined) {
      return [{ note: `Asking ${provider.name} for its models…` }];
    }
    return provider.models.map((model) => ({
      value: `${provider.name}/${model}`,
      label: model,
      group: provider.name,
      className: ID_CLASS,
      keywords: [provider.name],
    }));
  });
  return [...poolEntries, ...providerEntries];
}
