import { AGENT_SPEC } from '@cubicecho/agent-core/spec';
import { describe, expect, it } from 'vitest';
import { agentContextLength } from '../../server/agents/context-length.ts';
import { EMPTY_SNAPSHOT, type Snapshot, type SnapshotProvider } from '../../server/db/snapshot.ts';
import { AFFINITY_NONE, PoolStrategy } from '../../server/db/tables/pools.ts';
import { ModelCatalog } from '../../server/models/catalog.ts';
import type { UpstreamFetch } from '../../server/models/outbound.ts';

/**
 * Builds a provider for the snapshot.
 *
 * @param name - Its name, which is also its host.
 * @param [enabled] - Whether it is on.
 * @returns The provider.
 */
function provider(name: string, enabled = true): SnapshotProvider {
  return {
    id: `id-${name}`,
    name,
    enabled,
    baseUrl: `http://${name}/v1`,
    apiKey: null,
    headers: {},
    updatedAt: new Date(0),
  };
}

/** What each provider lists, by host. */
const LISTINGS: Record<string, unknown[]> = {
  vllm: [{ id: 'qwen3:32b', max_model_len: 32_768 }],
  openrouter: [{ id: 'qwen3:32b', context_length: 131_072 }],
  ollama: [{ id: 'qwen3:32b' }],
  off: [{ id: 'qwen3:32b', context_length: 1_024 }],
};

/** Answers each provider's `/models` from `LISTINGS`. */
const listing: UpstreamFetch = async (url) => {
  const host = new URL(url).hostname;
  const text = JSON.stringify({ data: LISTINGS[host] ?? [] });
  return { status: 200, ok: true, headers: new Headers(), body: null, text: async () => text };
};

const SNAPSHOT: Snapshot = {
  ...EMPTY_SNAPSHOT,
  providers: new Map(
    [provider('vllm'), provider('openrouter'), provider('ollama'), provider('off', false)].map((p) => [p.name, p]),
  ),
  pools: new Map([
    [
      'big',
      {
        id: 'pool-big',
        name: 'big',
        enabled: true,
        strategy: PoolStrategy.LeastBusy,
        affinity: AFFINITY_NONE,
        maxLoadFactor: null,
        targets: ['vllm', 'openrouter', 'ollama', 'off'].map((name) => ({
          providerId: `id-${name}`,
          providerName: name,
          model: 'qwen3:32b',
        })),
      },
    ],
  ]),
};

/**
 * Works out an agent's context length against the snapshot above.
 *
 * @param model - The document's `model`.
 * @param [extra] - More of the document.
 * @returns The context length, or null.
 */
function lengthFor(model: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<number | null> {
  const document = { spec: AGENT_SPEC, id: 'helper', model, tools: { servers: [] }, ...extra };
  return agentContextLength('helper', document, SNAPSHOT, new ModelCatalog(listing));
}

describe("an agent's context length", () => {
  it("is the document's when it states one above zero", async () => {
    expect(await lengthFor({ model: 'vllm/qwen3:32b', contextLength: 8_192 })).toBe(8_192);
    expect(await lengthFor({ model: 'vllm/qwen3:32b', contextLength: 0 })).toBe(32_768);
  });

  it("is otherwise what the model's provider lists, under whichever key it uses", async () => {
    expect(await lengthFor({ model: 'vllm/qwen3:32b' })).toBe(32_768);
    expect(await lengthFor({ model: 'openrouter/qwen3:32b' })).toBe(131_072);
  });

  it("is a pool's smallest known one, leaving out targets that state none and providers that are off", async () => {
    expect(await lengthFor({ model: 'big' })).toBe(32_768);
  });

  it('is unknown when nothing states it, the provider is off, or the agent calls its own endpoint', async () => {
    expect(await lengthFor({ model: 'ollama/qwen3:32b' })).toBeNull();
    expect(await lengthFor({ model: 'off/qwen3:32b' })).toBeNull();
    expect(await lengthFor({ model: 'vllm/other' })).toBeNull();
    expect(await lengthFor({ model: 'no-such-pool' })).toBeNull();
    expect(await lengthFor({ model: 'vllm/qwen3:32b' }, { endpoint: { baseUrl: 'http://vllm/v1' } })).toBeNull();
  });
});
