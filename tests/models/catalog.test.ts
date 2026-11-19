import { describe, expect, it } from 'vitest';
import type { SnapshotProvider } from '../../server/db/snapshot.ts';
import { contextLengthOf, ModelCatalog, ModelListError } from '../../server/models/catalog.ts';
import type { UpstreamFetch, UpstreamResponse } from '../../server/models/outbound.ts';

const PROVIDER: SnapshotProvider = {
  id: 'p1',
  name: 'ollama',
  enabled: true,
  baseUrl: 'http://ollama/v1/',
  apiKey: null,
  headers: {},
  updatedAt: new Date(0),
};

/**
 * Builds an answer with a JSON-ish body.
 *
 * @param status - The status.
 * @param text - The body.
 * @returns The answer.
 */
function answer(status: number, text: string): UpstreamResponse {
  return { status, ok: status < 300, headers: new Headers(), body: null, text: async () => text };
}

/**
 * Builds a fake provider that counts the listings it serves.
 *
 * @param answers - What it answers, in turn; the last one repeats.
 * @returns The fetch and the URLs it was asked.
 */
function fakeProvider(...answers: (UpstreamResponse | Error)[]) {
  const asked: string[] = [];
  const fetch: UpstreamFetch = async (url) => {
    const next = answers[Math.min(asked.length, answers.length - 1)];
    asked.push(url);
    if (next instanceof Error || next === undefined) {
      throw next ?? new Error('no answer');
    }
    return next;
  };
  return { fetch, asked };
}

const LIST = answer(200, JSON.stringify({ data: [{ id: 'qwen3:8b' }] }));

describe('ModelCatalog', () => {
  it('lists at <baseUrl>/models and reuses the listing while it is fresh', async () => {
    let clock = 0;
    const { fetch, asked } = fakeProvider(LIST);
    const catalog = new ModelCatalog(fetch, { modelListCacheSeconds: 60 }, () => clock);
    expect(await catalog.list(PROVIDER)).toEqual([{ id: 'qwen3:8b' }]);
    await catalog.list(PROVIDER);
    expect(asked).toEqual(['http://ollama/v1/models']);
    clock = 61_000;
    await catalog.list(PROVIDER);
    expect(asked).toHaveLength(2);
  });

  it('asks again once the provider has changed', async () => {
    const { fetch, asked } = fakeProvider(LIST);
    const catalog = new ModelCatalog(fetch);
    await catalog.list(PROVIDER);
    await catalog.list({ ...PROVIDER, updatedAt: new Date(1) });
    expect(asked).toHaveLength(2);
  });

  it('asks anew on a refresh, and reuses that listing after', async () => {
    const { fetch, asked } = fakeProvider(LIST);
    const catalog = new ModelCatalog(fetch);
    await catalog.list(PROVIDER);
    expect(await catalog.refresh(PROVIDER)).toEqual([{ id: 'qwen3:8b' }]);
    await catalog.list(PROVIDER);
    expect(asked).toHaveLength(2);
  });

  it('gives up on a refresh past its own timeout', async () => {
    const fetch: UpstreamFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    await expect(new ModelCatalog(fetch).refresh(PROVIDER, 10)).rejects.toThrow(/Could not reach ollama/);
  });

  it('does not cache a failure', async () => {
    const { fetch, asked } = fakeProvider(new Error('refused'), LIST);
    const catalog = new ModelCatalog(fetch);
    await expect(catalog.list(PROVIDER)).rejects.toThrow(ModelListError);
    expect(await catalog.list(PROVIDER)).toEqual([{ id: 'qwen3:8b' }]);
    expect(asked).toHaveLength(2);
  });

  it('waits for a listing only so long, and keeps the late one for the next ask', async () => {
    let release = () => {};
    const slow: UpstreamFetch = () =>
      new Promise((resolve) => {
        release = () => resolve(LIST);
      });
    const catalog = new ModelCatalog(slow, { modelListWaitMs: 10 });
    expect(await catalog.listWithin(PROVIDER)).toBeNull();
    release();
    expect(await catalog.listWithin(PROVIDER)).toEqual([{ id: 'qwen3:8b' }]);
    const { fetch } = fakeProvider(new Error('refused'));
    expect(await new ModelCatalog(fetch).listWithin(PROVIDER)).toBeNull();
  });

  it.each([
    ['a refusal', answer(401, 'no key'), /answered 401/],
    ['an answer that is not a model list', answer(200, '<html>'), /did not answer/],
  ])('says what went wrong for %s', async (_label, wrong, message) => {
    const { fetch } = fakeProvider(wrong);
    await expect(new ModelCatalog(fetch).list(PROVIDER)).rejects.toThrow(message);
  });
});

describe('contextLengthOf', () => {
  it('reads the first key a server states the context window under, and nothing that is not a whole number above 0', () => {
    expect(contextLengthOf({ id: 'a', max_model_len: 32_768 })).toBe(32_768);
    expect(contextLengthOf({ id: 'a', context_length: 8_192, n_ctx: 4_096 })).toBe(8_192);
    expect(contextLengthOf({ id: 'a', context_length: 0, n_ctx: 4_096 })).toBe(4_096);
    expect(contextLengthOf({ id: 'a', context_length: '8192' })).toBeNull();
    expect(contextLengthOf({ id: 'a', meta: { n_ctx_train: 262_144 } })).toBeNull();
    expect(contextLengthOf({ id: 'a' })).toBeNull();
  });
});
