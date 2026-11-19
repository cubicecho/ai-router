import { z } from 'zod';
import { MODEL_DEFAULTS, type ModelSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import type { SnapshotProvider } from '../db/snapshot.ts';
import type { UpstreamFetch } from './outbound.ts';
import { upstreamUrl } from './outbound.ts';
import { providerHeaders } from './provider-headers.ts';

/** One model as a provider lists it. Only the id is relied on; the rest is kept. */
const upstreamModelSchema = z.object({ id: z.string().min(1) }).loose();

/** What `GET <baseUrl>/models` answers. */
const upstreamModelListSchema = z.object({ data: z.array(upstreamModelSchema) });

/** One model as a provider lists it. */
export type UpstreamModel = z.infer<typeof upstreamModelSchema>;

/** A provider whose model list could not be read. The message says why, for the person looking. */
export class ModelListError extends Error {
  /**
   * Builds the error.
   *
   * @param message - What went wrong, naming the provider.
   */
  constructor(message: string) {
    super(message);
    this.name = 'ModelListError';
  }
}

/** A listing held for reuse. */
interface CachedListing {
  /** When the provider last changed, as the listing was fetched. A later change makes it stale. */
  providerUpdatedAt: number;
  /** When the listing stops being reused, in ms since the epoch. */
  expiresAt: number;
  models: Promise<UpstreamModel[]>;
}

/** Lists each provider's models, reusing a recent listing. */
export class ModelCatalog {
  private readonly fetch: UpstreamFetch;
  private readonly settings: ModelSettings;
  private readonly now: () => number;
  private readonly listings = new Map<string, CachedListing>();

  /**
   * Builds an empty catalog; nothing is fetched until a listing is asked for.
   *
   * @param fetch - Reaches the providers.
   * @param [overrides] - Settings that differ from `MODEL_DEFAULTS`.
   * @param [now] - The clock, in ms since the epoch.
   */
  constructor(fetch: UpstreamFetch, overrides: Partial<ModelSettings> = {}, now: () => number = Date.now) {
    this.fetch = fetch;
    this.settings = { ...MODEL_DEFAULTS, ...overrides };
    this.now = now;
  }

  /**
   * Lists a provider's models, from the cache while a listing of this same provider is fresh.
   *
   * @param provider - The provider.
   * @returns The models as the provider lists them.
   * @throws {@link ModelListError} When the provider can't be listed. A failure is not cached.
   *
   * @remarks
   * A listing is kept per provider and dropped when that provider changes. llm-router dropped every provider's
   * listing on any save.
   */
  list(provider: SnapshotProvider): Promise<UpstreamModel[]> {
    const cached = this.listings.get(provider.id);
    const isFresh =
      cached !== undefined &&
      cached.providerUpdatedAt === provider.updatedAt.getTime() &&
      cached.expiresAt > this.now();
    if (isFresh) {
      return cached.models;
    }
    return this.refresh(provider);
  }

  /**
   * Lists a provider's models anew, and keeps the listing for `list` to reuse.
   *
   * @param provider - The provider.
   * @param [timeoutMs] - How long the provider may take; the health checks wait less than a person would.
   * @returns The models as the provider lists them.
   * @throws {@link ModelListError} When the provider can't be listed. A failure is not cached.
   */
  refresh(provider: SnapshotProvider, timeoutMs = this.settings.modelListTimeoutMs): Promise<UpstreamModel[]> {
    const models = this.fetchModels(provider, timeoutMs);
    this.listings.set(provider.id, {
      providerUpdatedAt: provider.updatedAt.getTime(),
      expiresAt: this.now() + this.settings.modelListCacheSeconds * MS_PER_SECOND,
      models,
    });
    models.catch(() => {
      if (this.listings.get(provider.id)?.models === models) {
        this.listings.delete(provider.id);
      }
    });
    return models;
  }

  /**
   * Fetches `<baseUrl>/models` from a provider.
   *
   * @param provider - The provider.
   * @param timeoutMs - How long it may take.
   * @returns The models it lists.
   * @throws {@link ModelListError} For an unreachable or slow provider, a non-2xx answer or an unexpected body.
   */
  private async fetchModels(provider: SnapshotProvider, timeoutMs: number): Promise<UpstreamModel[]> {
    const url = upstreamUrl(provider.baseUrl, 'models');
    let status: number;
    let isOk: boolean;
    let text: string;
    try {
      const answer = await this.fetch(url, {
        method: 'GET',
        headers: providerHeaders(provider),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = answer.status;
      isOk = answer.ok;
      text = await answer.text();
    } catch (error) {
      throw new ModelListError(`Could not reach ${provider.name} at ${url}: ${errorMessage(error)}`);
    }
    if (isOk === false) {
      throw new ModelListError(
        `${provider.name} answered ${status} at ${url}: ${text.slice(0, this.settings.errorBodyMaxChars)}`,
      );
    }
    try {
      return upstreamModelListSchema.parse(JSON.parse(text)).data;
    } catch {
      throw new ModelListError(`${provider.name} did not answer ${url} with an OpenAI model list.`);
    }
  }
}
