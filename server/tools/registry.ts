import { z } from 'zod';
import { REGISTRY_DEFAULTS, type RegistrySettings } from '../core/defaults.ts';
import { errorMessage, notFound, upstreamFailed } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import { HttpStatus } from '../core/wire.ts';

/**
 * The official MCP registry API (https://registry.modelcontextprotocol.io, server.json schema
 * 2025-12-11), and any service that speaks it. Ported from mcp-router's `shared/src/registry.ts` and
 * `server/src/registry/client.ts`. Parsed leniently: only the fields the router reads are modelled,
 * and the rest is kept.
 */

/** A registry to browse and install from, as the `registries` table keeps it. */
export interface Registry {
  /** Its name, which install sources refer to it by. */
  name: string;
  /** The base URL of a service that speaks the MCP registry API. */
  url: string;
}

/** What a page of a registry's servers is asked for with. An empty or zero value is not sent. */
export interface RegistrySearch {
  search?: string;
  /** `metadata.nextCursor` of the page before. */
  cursor?: string;
  limit?: number;
}

/** Reaches a registry. The global `fetch` fits; tests pass a fake. */
export type RegistryFetch = (url: URL, init: RequestInit) => Promise<Response>;

/** A named input a registry entry declares: an env var or a header. */
export const registryKeyValueInputSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    isRequired: z.boolean().optional(),
    isSecret: z.boolean().optional(),
    default: z.string().optional(),
    placeholder: z.string().optional(),
    choices: z.array(z.string()).nullish(),
    value: z.string().optional(),
    format: z.string().optional(),
  })
  .loose();

/** A command-line argument a registry package declares, positional or named. */
export const registryArgumentSchema = registryKeyValueInputSchema
  .extend({
    // Only named arguments carry a name. Positional ones have a value or a value hint.
    name: z.string().optional(),
    /** `positional` or `named`. */
    type: z.string().optional(),
    valueHint: z.string().optional(),
    isRepeated: z.boolean().optional(),
  })
  .loose();

/** The transport a registry package says it speaks. */
export const registryTransportSchema = z
  .object({
    /** `stdio`, `streamable-http` or `sse`. */
    type: z.string(),
    url: z.string().optional(),
    headers: z.array(registryKeyValueInputSchema).optional(),
  })
  .loose();

/** One installable package of a registry entry. */
export const registryPackageSchema = z
  .object({
    /** `npm`, `pypi`, `oci`, `nuget` or `mcpb`. */
    registryType: z.string(),
    registryBaseUrl: z.string().optional(),
    identifier: z.string(),
    version: z.string().optional(),
    /** Such as `npx`. */
    runtimeHint: z.string().optional(),
    transport: registryTransportSchema.optional(),
    runtimeArguments: z.array(registryArgumentSchema).optional(),
    packageArguments: z.array(registryArgumentSchema).optional(),
    environmentVariables: z.array(registryKeyValueInputSchema).optional(),
  })
  .loose();

/** One hosted endpoint of a registry entry, connected to rather than installed. */
export const registryRemoteSchema = z
  .object({
    /** `streamable-http` or `sse`. */
    type: z.string(),
    url: z.string(),
    headers: z.array(registryKeyValueInputSchema).optional(),
  })
  .loose();

/** The `server` object of a registry entry. */
export const registryServerSchema = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    version: z.string().optional(),
    websiteUrl: z.string().optional(),
    repository: z.object({ url: z.string().optional(), source: z.string().optional() }).loose().optional(),
    packages: z.array(registryPackageSchema).optional(),
    remotes: z.array(registryRemoteSchema).optional(),
  })
  .loose();

/** One entry of a registry: `{ server, _meta }`. */
export const registryServerEntrySchema = z
  .object({
    server: registryServerSchema,
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

/** A page of `GET /v0/servers`. `metadata.nextCursor` asks for the page after it. */
export const registryListResponseSchema = z
  .object({
    servers: z.array(registryServerEntrySchema),
    metadata: z
      .object({
        nextCursor: z.string().optional(),
        count: z.number().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

/** An env var or header a registry entry declares. */
export type RegistryKeyValueInput = z.infer<typeof registryKeyValueInputSchema>;
/** A command-line argument a registry package declares. */
export type RegistryArgument = z.infer<typeof registryArgumentSchema>;
/** One installable package of a registry entry. */
export type RegistryPackage = z.infer<typeof registryPackageSchema>;
/** One hosted endpoint of a registry entry. */
export type RegistryRemote = z.infer<typeof registryRemoteSchema>;
/** A registry entry's `server` object. */
export type RegistryServer = z.infer<typeof registryServerSchema>;
/** One entry of a registry. */
export type RegistryServerEntry = z.infer<typeof registryServerEntrySchema>;
/** A page of a registry's servers. */
export type RegistryListResponse = z.infer<typeof registryListResponseSchema>;

/**
 * Makes a registry's URL safe to resolve relative paths against.
 *
 * @param registry - The registry.
 * @returns Its URL, ending in a slash.
 */
function baseUrl(registry: Registry): string {
  return registry.url.endsWith('/') ? registry.url : `${registry.url}/`;
}

/** Reads registries that speak the MCP registry API: `GET /v0/servers` and `GET /v0/servers/{name}/versions/latest`. */
export class RegistryClient {
  private readonly fetch: RegistryFetch;
  private readonly settings: RegistrySettings;

  /**
   * Builds a client; nothing is fetched until asked.
   *
   * @param [fetchImpl] - Reaches the registries.
   * @param [overrides] - Settings that differ from `REGISTRY_DEFAULTS`.
   */
  constructor(fetchImpl: RegistryFetch = fetch, overrides: Partial<RegistrySettings> = {}) {
    this.fetch = fetchImpl;
    this.settings = { ...REGISTRY_DEFAULTS, ...overrides };
  }

  /**
   * Fetches one page of a registry's servers, latest versions only.
   *
   * @param registry - The registry to ask.
   * @param [params] - Search text, cursor and page size.
   * @returns The page. A registry's `servers: null` reads as empty.
   * @throws UPSTREAM_FAILED for an unreachable or slow registry, a failed answer, or an unexpected body.
   */
  async listServers(registry: Registry, params: RegistrySearch = {}): Promise<RegistryListResponse> {
    const { search = '', cursor = '', limit = 0 } = params;
    const url = new URL('v0/servers', baseUrl(registry));
    url.searchParams.set('version', 'latest');
    if (search !== '') {
      url.searchParams.set('search', search);
    }
    if (cursor !== '') {
      url.searchParams.set('cursor', cursor);
    }
    if (limit > 0) {
      url.searchParams.set('limit', String(limit));
    }
    const body = await this.fetchJson(url, registry, null);
    // The registry's ServerListResponse answers an empty search with servers: null.
    const isEmpty = isRecord(body) && body.servers === null;
    return this.parse(registryListResponseSchema, isEmpty ? { ...body, servers: [] } : body, registry);
  }

  /**
   * Fetches the latest version of one registry entry.
   *
   * @param registry - The registry to ask.
   * @param serverName - The entry's full name, slashes included. It is URL-encoded here.
   * @returns The entry.
   * @throws NOT_FOUND when the registry has no entry by that name. UPSTREAM_FAILED as `listServers`.
   */
  async getServer(registry: Registry, serverName: string): Promise<RegistryServerEntry> {
    const url = new URL(`v0/servers/${encodeURIComponent(serverName)}/versions/latest`, baseUrl(registry));
    const body = await this.fetchJson(url, registry, `Registry "${registry.name}" has no server "${serverName}".`);
    return this.parse(registryServerEntrySchema, body, registry);
  }

  /**
   * GETs a registry URL and reads its JSON body.
   *
   * @param url - The URL.
   * @param registry - Named in the errors.
   * @param notFoundMessage - What a 404 is reported as, or null to report it like any failed answer.
   * @returns The parsed body.
   * @throws NOT_FOUND for a 404 with a message. UPSTREAM_FAILED for a timeout, an unreachable registry, any
   * other answer outside 2xx, or a body that isn't JSON.
   */
  private async fetchJson(url: URL, registry: Registry, notFoundMessage: string | null): Promise<unknown> {
    const { fetchTimeoutMs, errorBodyMaxChars } = this.settings;
    let response: Response;
    try {
      response = await this.fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
    } catch (error) {
      const isTimeout = error instanceof Error && error.name === 'TimeoutError';
      if (isTimeout) {
        throw upstreamFailed(`Registry "${registry.name}" did not answer within ${fetchTimeoutMs} ms.`);
      }
      throw upstreamFailed(`Registry "${registry.name}" is unreachable: ${errorMessage(error)}`);
    }
    if (response.status === HttpStatus.NotFound && notFoundMessage !== null) {
      throw notFound(notFoundMessage);
    }
    if (response.ok === false) {
      const text = await response.text().catch(() => '');
      throw upstreamFailed(
        `Registry "${registry.name}" answered HTTP ${response.status}: ${text.slice(0, errorBodyMaxChars)}`,
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw upstreamFailed(`Registry "${registry.name}" did not answer with JSON: ${errorMessage(error)}`);
    }
  }

  /**
   * Checks a registry's answer against the shape expected of it.
   *
   * @typeParam Output - What the schema parses to.
   * @param schema - The shape.
   * @param body - The parsed JSON.
   * @param registry - Named in the error.
   * @returns The checked body.
   * @throws UPSTREAM_FAILED when it doesn't have the shape.
   */
  private parse<Output>(schema: z.ZodType<Output>, body: unknown, registry: Registry): Output {
    const result = schema.safeParse(body);
    if (result.success === false) {
      throw upstreamFailed(
        `Registry "${registry.name}" answered in an unexpected shape: ${result.error.issues[0]?.message ?? ''}`,
      );
    }
    return result.data;
  }
}
