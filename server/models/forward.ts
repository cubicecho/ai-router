import { MODEL_DEFAULTS, type ModelSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import type { Snapshot, SnapshotHost, SnapshotProvider } from '../db/snapshot.ts';
import { AFFINITY_STICKY } from '../db/tables/pools.ts';
import { affinityKey, SESSION_HEADER } from './affinity.ts';
import type { PoolBalancer } from './balancer.ts';
import type { ModelCatalog } from './catalog.ts';
import { modelId, splitModelId } from './naming.ts';
import { ModelFailure, openAiError } from './openai-error.ts';
import { type UpstreamFetch, type UpstreamResponse, upstreamUrl } from './outbound.ts';
import { JSON_CONTENT_TYPE, providerHeaders } from './provider-headers.ts';
import type { ServedBy, UsageRecorder } from './usage.ts';
import { UsageReader } from './usage-reader.ts';

/**
 * The address a run's endpoint points at. No server answers it: the run's `fetch` hands every call to `forward`.
 * `.invalid` is reserved, so a call that escaped would go nowhere.
 */
export const MODELS_BASE_URL = 'http://models.ai-router.invalid/v1';

/**
 * Answer headers that describe the provider's connection or encoding, not the body passed on, and `set-cookie`,
 * which would let a provider set cookies on the router's own origin.
 */
const UNFORWARDED_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'proxy-authenticate',
  'trailer',
  'upgrade',
  'set-cookie',
]);

/** Path segments that would walk a provider URL out of its base path. */
const DOT_SEGMENTS = new Set(['.', '..']);

/** Paths whose streams report token counts only when `stream_options.include_usage` asks for them. */
const STREAM_USAGE_PATHS = new Set(['chat/completions', 'completions']);

/** The content type of a server-sent event stream. */
const EVENT_STREAM_TYPE = 'text/event-stream';

/** The path a model listing is asked for at. */
const MODELS_PATH = 'models';

/** Who a call counts under, apart from where it goes. */
export type Attribution = Omit<ServedBy, 'providerId' | 'providerName' | 'model'>;

/** One call to forward. */
export interface ModelCall {
  /** The path under `/v1`, such as `chat/completions`, with its query string. */
  path: string;
  /** The parsed JSON body. */
  body: unknown;
  /** Who it counts under. */
  attribution: Attribution;
  /** Abandons the call, and the answer's body after it. */
  signal?: AbortSignal;
  /** The caller's `Accept` header. */
  accept?: string;
  /** The caller's `X-Session-Id`, which keeps its calls on one target of a sticky pool. */
  sessionId?: string;
}

/** What forwarding talks to. */
export interface ForwarderDeps {
  snapshot: SnapshotHost;
  balancer: PoolBalancer;
  catalog: ModelCatalog;
  usage: UsageRecorder;
  fetch: UpstreamFetch;
  /** Settings that differ from `MODEL_DEFAULTS`. */
  overrides?: Partial<ModelSettings>;
}

/** Hands model calls to providers. */
export interface Forwarder {
  /**
   * Sends one call to the provider its `model` names, directly or through a pool.
   *
   * @param call - The path, body and attribution.
   * @returns The provider's answer, passed through, or the router's own refusal in OpenAI's error envelope.
   */
  forward(call: ModelCall): Promise<Response>;
  /**
   * Lists every model id and pool a run can name, with what each provider says of its models.
   *
   * @returns An OpenAI model list. A provider that can't be listed is left out and logged.
   */
  listModels(): Promise<Response>;
  /**
   * Builds the `fetch` a run's endpoint uses, answering `MODELS_BASE_URL` in process.
   *
   * @param attribution - Who the run's calls count under.
   * @returns A `fetch` for the run.
   */
  fetchFor(attribution: Attribution): typeof globalThis.fetch;
}

/** Where a call goes, and what frees its pool slot. */
interface Route {
  provider: SnapshotProvider;
  /** The model's id at the provider. */
  model: string;
  /** Frees a pool target's slot. Does nothing for a call that named a provider's model. */
  release: () => void;
}

/** The release of a call that holds no pool slot. */
const NOTHING_TO_RELEASE = (): void => {};

/** A refusal decided before any provider was asked. */
class Refusal extends Error {
  readonly failure: ModelFailure;

  /**
   * Builds the refusal.
   *
   * @param failure - What went wrong.
   * @param message - What the caller is told.
   */
  constructor(failure: ModelFailure, message: string) {
    super(message);
    this.name = 'Refusal';
    this.failure = failure;
  }
}

/**
 * Asks for token counts at the end of a streamed completion, which providers leave out unless asked.
 *
 * @param path - The path, such as `chat/completions`.
 * @param body - The body about to be sent.
 * @returns The body with `stream_options.include_usage` on, or the same body when it isn't a streamed completion or
 * the caller already chose.
 */
export function withStreamUsage(path: string, body: Record<string, unknown>): Record<string, unknown> {
  const isStreamedCompletion = STREAM_USAGE_PATHS.has(path) && body.stream === true;
  if (isStreamedCompletion === false) {
    return body;
  }
  const options = isRecord(body.stream_options) ? body.stream_options : {};
  if (options.include_usage !== undefined) {
    return body;
  }
  return { ...body, stream_options: { ...options, include_usage: true } };
}

/**
 * Finds where a model id goes: a pool's target, or a provider's model.
 *
 * @param snapshot - What the router routes by.
 * @param balancer - Places a call that names a pool.
 * @param body - The call's body, with its `model`.
 * @param sessionId - The caller's session header.
 * @returns The provider, the model's id there, and what frees a pool slot.
 * @throws {@link Refusal} For an unknown or disabled name (404), or a pool with no enabled target (503).
 */
function route(
  snapshot: Snapshot,
  balancer: PoolBalancer,
  body: Record<string, unknown> & { model: string },
  sessionId: string | null,
): Route {
  const name = body.model;
  const pool = snapshot.pools.get(name);
  if (pool?.enabled) {
    const candidates = pool.targets.filter((target) => snapshot.providers.get(target.providerName)?.enabled === true);
    if (candidates.length === 0) {
      throw new Refusal(ModelFailure.Unavailable, `Pool "${name}" has no target whose provider is enabled.`);
    }
    const key = pool.affinity === AFFINITY_STICKY ? affinityKey(body, sessionId) : null;
    const lease = balancer.acquire(pool, candidates, key);
    const provider = snapshot.providers.get(lease.providerName);
    if (provider === undefined) {
      lease.release();
      throw new Refusal(ModelFailure.Unavailable, `Pool "${name}" picked a provider that is gone.`);
    }
    return { provider, model: lease.model, release: lease.release };
  }
  const split = splitModelId(name);
  const provider = split === null ? undefined : snapshot.providers.get(split.providerName);
  if (split === null || provider === undefined || provider.enabled === false) {
    throw new Refusal(
      ModelFailure.ModelNotFound,
      `The model "${name}" does not exist on this router. Name a provider's model as <provider>/<model>, or a pool.`,
    );
  }
  return { provider, model: split.model, release: NOTHING_TO_RELEASE };
}

/**
 * Splits a path from its query string, refusing one that would leave the provider's base path.
 *
 * @param path - The path under `/v1`, with any query string.
 * @returns The path without a leading slash, and the query string with its `?`, or empty.
 * @throws {@link Refusal} For a path with `.` or `..` segments.
 */
function safePath(path: string): { path: string; search: string } {
  const queryAt = path.indexOf('?');
  const hasQuery = queryAt >= 0;
  const pathOnly = (hasQuery ? path.slice(0, queryAt) : path).replace(/^\/+/, '');
  const hasDotSegment = pathOnly.split('/').some((segment) => DOT_SEGMENTS.has(segment));
  if (hasDotSegment) {
    throw new Refusal(ModelFailure.BadRequest, `"${path}" is not a path the router forwards.`);
  }
  return { path: pathOnly, search: hasQuery ? path.slice(queryAt) : '' };
}

/**
 * Whether a body names a model.
 *
 * @param body - The parsed body.
 * @returns true for a JSON object whose `model` is a string that isn't empty.
 */
function namesModel(body: unknown): body is Record<string, unknown> & { model: string } {
  return isRecord(body) && typeof body.model === 'string' && body.model !== '';
}

/**
 * Copies an answer's headers, leaving out what describes the provider's connection.
 *
 * @param upstream - The provider's answer.
 * @returns The headers to pass on.
 */
function forwardedHeaders(upstream: UpstreamResponse): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    if (UNFORWARDED_RESPONSE_HEADERS.has(name.toLowerCase()) === false) {
      headers.append(name, value);
    }
  });
  return headers;
}

/**
 * Builds the forwarder.
 *
 * @param deps - The snapshot, the balancer, the catalog, the usage recorder and the outbound `fetch`.
 * @returns The forwarder.
 */
export function createForwarder({
  snapshot,
  balancer,
  catalog,
  usage,
  fetch,
  overrides = {},
}: ForwarderDeps): Forwarder {
  const settings = { ...MODEL_DEFAULTS, ...overrides };

  /**
   * Asks a provider, giving up if it hasn't started answering in time.
   *
   * @param url - The provider URL.
   * @param body - The body to send.
   * @param call - The call, for its signal and `Accept`.
   * @param provider - The provider, for its headers.
   * @returns The answer, headers received.
   * @throws {@link Refusal} 502 when the provider can't be reached, 504 when it doesn't answer in time.
   */
  const ask = async (
    url: string,
    body: Record<string, unknown>,
    call: ModelCall,
    provider: SnapshotProvider,
  ): Promise<UpstreamResponse> => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), settings.responseTimeoutMs);
    const signal = call.signal === undefined ? deadline.signal : AbortSignal.any([call.signal, deadline.signal]);
    try {
      return await fetch(url, {
        method: 'POST',
        headers: providerHeaders(provider, {
          accept: call.accept ?? JSON_CONTENT_TYPE,
          'content-type': JSON_CONTENT_TYPE,
        }),
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (deadline.signal.aborted) {
        throw new Refusal(
          ModelFailure.UpstreamTimeout,
          `${provider.name} did not start answering within ${settings.responseTimeoutMs} ms.`,
        );
      }
      call.signal?.throwIfAborted();
      throw new Refusal(ModelFailure.UpstreamFailed, `${provider.name} could not be reached: ${errorMessage(error)}`);
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Passes an answer's body through, reading its token counts as it goes, and settles the call when it ends.
   *
   * @param upstream - The provider's answer.
   * @param served - Who the call counts under.
   * @param release - Frees the pool slot.
   * @returns The answer to hand back.
   */
  const passThrough = (upstream: UpstreamResponse, served: ServedBy, release: () => void): Response => {
    const headers = forwardedHeaders(upstream);
    const isEventStream = (headers.get('content-type') ?? '').includes(EVENT_STREAM_TYPE);
    const reader = new UsageReader(isEventStream, settings.maxResponseBytes);
    let isSettled = false;
    // Exactly once, on every way an answer ends: finished, broken, or abandoned by the caller.
    const settle = (): void => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      release();
      // An answer cut short still cost what it had reported by then. A provider's error is not counted.
      if (upstream.ok) {
        usage.record(served, reader.result());
      }
    };
    if (upstream.body === null) {
      settle();
      return new Response(null, { status: upstream.status, headers });
    }
    const source = upstream.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await source.read();
          if (done) {
            settle();
            controller.close();
            return;
          }
          const chunk = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
          reader.push(chunk);
          controller.enqueue(chunk);
        } catch (error) {
          settle();
          console.warn(`[models] the answer from ${served.providerName} broke off: ${errorMessage(error)}`);
          controller.error(error);
        }
      },
      async cancel(reason) {
        settle();
        await source.cancel(reason);
      },
    });
    return new Response(body, { status: upstream.status, headers });
  };

  const forward = async (call: ModelCall): Promise<Response> => {
    let release = NOTHING_TO_RELEASE;
    try {
      const { body } = call;
      if (namesModel(body) === false) {
        throw new Refusal(
          ModelFailure.BadRequest,
          'The body must be a JSON object with a "model": <provider>/<model>, or a pool.',
        );
      }
      const { path, search } = safePath(call.path);
      const routed = route(snapshot.current(), balancer, body, call.sessionId ?? null);
      // From here the slot is held: every way out below frees it, or hands it to the answer's body.
      release = routed.release;
      const { provider, model } = routed;
      const sent = withStreamUsage(path, { ...body, model });
      const upstream = await ask(`${upstreamUrl(provider.baseUrl, path)}${search}`, sent, call, provider);
      const served: ServedBy = { ...call.attribution, providerId: provider.id, providerName: provider.name, model };
      const answer = passThrough(upstream, served, routed.release);
      release = NOTHING_TO_RELEASE;
      return answer;
    } catch (error) {
      release();
      if (error instanceof Refusal) {
        return openAiError(error.failure, error.message);
      }
      throw error;
    }
  };

  const listModels = async (): Promise<Response> => {
    const current = snapshot.current();
    const pools = [...current.pools.values()]
      .filter(
        (pool) => pool.enabled && pool.targets.some((target) => current.providers.get(target.providerName)?.enabled),
      )
      .map((pool) => ({ id: pool.name, object: 'model', created: 0, owned_by: 'pool' }));
    const enabled = [...current.providers.values()].filter((provider) => provider.enabled);
    const perProvider = await Promise.all(
      enabled.map(async (provider) => {
        try {
          const models = await catalog.list(provider);
          return models.map((upstream) => ({
            created: 0,
            ...upstream,
            id: modelId(provider.name, upstream.id),
            object: 'model',
            owned_by: provider.name,
          }));
        } catch (error) {
          console.warn(`[models] leaving ${provider.name} out of the model list: ${errorMessage(error)}`);
          return [];
        }
      }),
    );
    return Response.json({ object: 'list', data: [...pools, ...perProvider.flat()] });
  };

  const fetchFor = (attribution: Attribution): typeof globalThis.fetch => {
    return async (input, init) => {
      const request = new Request(input, init);
      const isOurs = request.url.startsWith(`${MODELS_BASE_URL}/`);
      if (isOurs === false) {
        return openAiError(ModelFailure.NotFound, `A run may call only its own models, not ${request.url}.`);
      }
      const path = request.url.slice(MODELS_BASE_URL.length + 1);
      if (request.method === 'GET') {
        const isListing = path.split('?')[0] === MODELS_PATH;
        return isListing
          ? listModels()
          : openAiError(ModelFailure.NotFound, `The router answers GET only for ${MODELS_PATH}.`);
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return openAiError(ModelFailure.BadRequest, 'The body must be JSON.');
      }
      return forward({
        path,
        body,
        attribution,
        signal: request.signal,
        accept: request.headers.get('accept') ?? undefined,
        sessionId: request.headers.get(SESSION_HEADER) ?? undefined,
      });
    };
  };

  return { forward, listModels, fetchFor };
}
