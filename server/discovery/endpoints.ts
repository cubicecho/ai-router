import { hostname } from 'node:os';
import {
  type AdvertisedEndpoint,
  airIdentifier,
  createServerCard,
  hostSlug,
  type KeyValueInput,
  TRANSPORT_STREAMABLE_HTTP,
} from '@cubicecho/mcp-discovery';

/** The reverse-DNS namespace every card's name starts with; the host's slug is appended to it. */
const CARD_NAMESPACE = 'io.github.cubicecho.ai-router';

/** What follows the host's slug in the catalog entry's `urn:air` publisher. */
const AIR_PUBLISHER = 'ai-router';

/** The project's source, shown on the card. */
const REPOSITORY = { url: 'https://github.com/cubicecho/ai-router', source: 'github' } as const;

/** The agents' MCP door, the router's only HTTP MCP endpoint: the admin server is reached in process. */
export const AGENTS_MCP_PATH = '/mcp';

/** The endpoint's stable name under the host, the last part of its card name and `urn:air` id. */
const ENDPOINT_NAME = 'agents';

/** The card's description; a Server Card allows 100 characters. It names no agent: those are listed only to a key. */
const DESCRIPTION = "Agents as MCP tools: one per agent a workspace key's workspace may run.";

/** The header every call needs; its value, a workspace key, is never in the card. */
const AUTH_HEADER: KeyValueInput = {
  name: 'Authorization',
  description: 'Bearer <workspace key>: an air_… key from a workspace in the router',
  isRequired: true,
  isSecret: true,
};

/**
 * The name the router announces itself by over mDNS, and skips when it finds itself.
 *
 * @param [host] - The machine's hostname.
 * @returns Such as `AI Router on nas`.
 */
export function mdnsInstanceName(host: string = hostname()): string {
  return `AI Router on ${host}`;
}

/** What the endpoints are built from. */
export interface DiscoveryEndpointOptions {
  /** The router's release, the card's version. */
  version: string;
  /**
   * The machine's hostname, which keeps card names apart when two routers share a network.
   *
   * @defaultValue `os.hostname()`
   */
  host?: string;
}

/**
 * Lists the MCP endpoints the router makes discoverable: `/mcp`, its only HTTP one.
 *
 * @param options - The version, and optionally the hostname.
 * @returns The endpoint, with a card builder that names the URL the request came in on.
 *
 * @remarks
 * The card names the endpoint and nothing behind it, since cards are public: which agents a key reaches is told only
 * to the key, by `tools/list`.
 */
export function discoveryEndpoints(options: DiscoveryEndpointOptions): AdvertisedEndpoint[] {
  const { version, host = hostname() } = options;
  const slug = hostSlug(host);
  return [
    {
      path: AGENTS_MCP_PATH,
      identifier: airIdentifier(`${slug}.${AIR_PUBLISHER}`, ENDPOINT_NAME),
      card: ({ endpointUrl }) =>
        createServerCard({
          name: `${CARD_NAMESPACE}.${slug}/${ENDPOINT_NAME}`,
          version,
          title: `AI Router on ${host}`,
          description: DESCRIPTION,
          repository: REPOSITORY,
          remotes: [{ type: TRANSPORT_STREAMABLE_HTTP, url: endpointUrl, headers: [AUTH_HEADER] }],
        }),
    },
  ];
}
