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

/**
 * The keys a provider's listing states a model's context window under: none is in OpenAI's schema, so each server
 * picks its own (`max_model_len` is vLLM, `context_length` OpenRouter, `n_ctx` the llama bindings). The same list,
 * in the same order, as agent-core's.
 */
const CONTEXT_KEYS: readonly string[] = Object.freeze([
  'context_length',
  'max_context_length',
  'max_context_window',
  'max_model_len',
  'context_window',
  'n_ctx',
]);

/**
 * Reads the context window a provider's listing states for a model.
 *
 * @param model - The model, as listed.
 * @returns The first whole number above zero under one of `CONTEXT_KEYS`, in tokens, or null when none states one.
 *
 * @remarks
 * llama.cpp's `meta.n_ctx_train` is left out: it is the window the model was trained with, which the server may run
 * well under.
 */
export function contextLengthOf(model: UpstreamModel): number | null {
  for (const key of CONTEXT_KEYS) {
    const value = model[key];
    const isStated = typeof value === 'number' && Number.isInteger(value) && value > 0;
    if (isStated) {
      return value;
    }
  }
  return null;
}

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
    const models = this.fetchModels(provider);
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
   * Lists a provider's models without making the caller wait long for them.
   *
   * @param provider - The provider.
   * @returns The models, from the cache or a listing that arrives within `modelListWaitMs`. Null when it doesn't
   * arrive in time or fails; a late listing still lands in the cache for the next ask.
   */
  async listWithin(provider: SnapshotProvider): Promise<UpstreamModel[] | null> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.settings.modelListWaitMs);
    });
    try {
      return await Promise.race([this.list(provider).catch(() => null), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Drops a provider's cached listing, so the next one is fetched.
   *
   * @param providerId - The provider; an unknown one is not an error.
   */
  forget(providerId: string): void {
    this.listings.delete(providerId);
  }

  /**
   * Fetches `<baseUrl>/models` from a provider.
   *
   * @param provider - The provider.
   * @returns The models it lists.
   * @throws {@link ModelListError} For an unreachable or slow provider, a non-2xx answer or an unexpected body.
   */
  private async fetchModels(provider: SnapshotProvider): Promise<UpstreamModel[]> {
    const url = upstreamUrl(provider.baseUrl, 'models');
    let status: number;
    let isOk: boolean;
    let text: string;
    try {
      const answer = await this.fetch(url, {
        method: 'GET',
        headers: providerHeaders(provider),
        signal: AbortSignal.timeout(this.settings.modelListTimeoutMs),
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
