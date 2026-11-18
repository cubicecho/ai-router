import type { ReadableStream } from 'node:stream/web';
import { Agent, fetch } from 'undici';
import { MODEL_DEFAULTS } from '../core/defaults.ts';

/** What the router sends a provider. */
export interface UpstreamRequest {
  method: string;
  headers: Record<string, string>;
  /** A JSON document, already serialised. */
  body?: string;
  /** Abandons the request, and the answer's body after it. */
  signal?: AbortSignal;
}

/** The part of a provider's answer the router reads. */
export interface UpstreamResponse {
  status: number;
  /** True for a 2xx status. */
  ok: boolean;
  headers: { forEach(callback: (value: string, name: string) => void): void };
  /** Null when the answer has no body. Its chunks are bytes. */
  body: ReadableStream | null;
  /** Reads the whole body as text. */
  text(): Promise<string>;
}

/** How the router reaches providers. Tests pass their own. */
export type UpstreamFetch = (url: string, request: UpstreamRequest) => Promise<UpstreamResponse>;

/**
 * Builds the `fetch` the router reaches providers with.
 *
 * @param [keepAliveMs] - How long an idle connection is kept for the next call.
 * @returns A `fetch` that never times an answer out itself.
 *
 * @remarks
 * undici gives up on headers and on a quiet body after 300 s each, which a slow local model outlasts. The router
 * bounds the wait for headers itself (`MODEL_DEFAULTS.responseTimeoutMs`), and a stream runs as long as it needs.
 */
export function createOutboundFetch(keepAliveMs = MODEL_DEFAULTS.keepAliveMs): UpstreamFetch {
  const dispatcher = new Agent({ keepAliveTimeout: keepAliveMs, headersTimeout: 0, bodyTimeout: 0 });
  return async (url, request) => {
    const response = await fetch(url, { ...request, dispatcher });
    return {
      status: response.status,
      ok: response.ok,
      headers: response.headers,
      body: response.body,
      text: () => response.text(),
    };
  };
}

/**
 * Joins a provider's base URL and a path under it.
 *
 * @param baseUrl - The provider's OpenAI base URL, with or without a trailing slash.
 * @param path - The path under it, without a leading slash, such as `chat/completions`.
 * @returns The full URL.
 */
export function upstreamUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path}`;
}
