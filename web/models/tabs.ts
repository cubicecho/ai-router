import { tabSearch } from '../lib/tab-search';

/** A provider page's tabs, the default first. */
export const PROVIDER_TABS = ['overview', 'models', 'usage'] as const;
export type ProviderTab = (typeof PROVIDER_TABS)[number];

/** The provider route's `validateSearch`: the open tab. */
export const validateProviderSearch = tabSearch(PROVIDER_TABS);

/** A pool page's tabs, the default first. */
export const POOL_TABS = ['overview', 'targets', 'usage'] as const;
export type PoolTab = (typeof POOL_TABS)[number];

/** The pool route's `validateSearch`: the open tab. */
export const validatePoolSearch = tabSearch(POOL_TABS);
