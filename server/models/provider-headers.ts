import type { SnapshotProvider } from '../db/snapshot.ts';

/** The media type of a JSON body. */
export const JSON_CONTENT_TYPE = 'application/json';

/**
 * Builds the headers every call to a provider carries.
 *
 * @param provider - The provider.
 * @param [defaults] - This call's own headers, with lower-cased names.
 * @returns Lower-cased header names: the defaults, `authorization` from the key when one is set, then the provider's
 * own headers, which replace any of the same name.
 */
export function providerHeaders(
  provider: Pick<SnapshotProvider, 'apiKey' | 'headers'>,
  defaults: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = { accept: JSON_CONTENT_TYPE, ...defaults };
  if (provider.apiKey !== null && provider.apiKey !== '') {
    headers.authorization = `Bearer ${provider.apiKey}`;
  }
  for (const [name, value] of Object.entries(provider.headers)) {
    headers[name.toLowerCase()] = value;
  }
  return headers;
}
