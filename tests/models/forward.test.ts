import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_SNAPSHOT, type Snapshot, type SnapshotHost, type SnapshotProvider } from '../../server/db/snapshot.ts';
import { AFFINITY_NONE, PoolStrategy } from '../../server/db/tables/pools.ts';
import { PoolBalancer } from '../../server/models/balancer.ts';
import { ModelCatalog } from '../../server/models/catalog.ts';
import { type Attribution, createForwarder, type Forwarder, MODELS_BASE_URL } from '../../server/models/forward.ts';
import { createOutboundFetch } from '../../server/models/outbound.ts';
import type { ServedBy, UsageRecorder } from '../../server/models/usage.ts';
import type { ReportedUsage } from '../../server/models/usage-reader.ts';
import { portOf } from '../helpers.ts';

// The forwarder against a stand-in OpenAI server on a real socket, through the real undici fetch.

const ATTRIBUTION: Attribution = { workspaceId: 'w1', workspaceName: 'min-agent', agentId: null, agentName: null };
const KEY = 'sk-provider-secret';
const SHORT_TIMEOUT_MS = 200;

/** What the stand-in provider was last sent. */
interface Received {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

let provider: Server;
let baseUrl: string;
let received: Received[];
let recorded: { served: ServedBy; reported: ReportedUsage | undefined }[];
let snapshot: Snapshot;
let balancer: PoolBalancer;
let forwarder: Forwarder;

/**
 * Builds a provider entry pointing at the stand-in.
 *
 * @param name - Its name.
 * @param [overrides] - Fields that differ.
 * @returns The provider.
 */
function providerEntry(name: string, overrides: Partial<SnapshotProvider> = {}): SnapshotProvider {
  return {
    id: `id-${name}`,
    name,
    enabled: true,
    baseUrl,
    apiKey: KEY,
    headers: { 'x-extra': 'yes' },
    updatedAt: new Date(0),
    ...overrides,
  };
}

/**
 * Builds a forwarder over the current snapshot.
 *
 * @param [responseTimeoutMs] - How long the provider may take to start answering.
 * @returns The forwarder.
 */
function build(responseTimeoutMs?: number): Forwarder {
  const host: SnapshotHost = { current: () => snapshot, rebuild: async () => {} };
  const usage: UsageRecorder = {
    record: (served, reported) => {
      recorded.push({ served, reported });
    },
    flush: async () => {},
    fold: async () => {},
    start: () => {},
    stop: async () => {},
  };
  const fetch = createOutboundFetch();
  return createForwarder({
    snapshot: host,
    balancer,
    catalog: new ModelCatalog(fetch),
    usage,
    fetch,
    overrides: responseTimeoutMs === undefined ? {} : { responseTimeoutMs },
  });
}

/**
 * Calls the forwarder as a run's endpoint would.
 *
 * @param path - The path under /v1.
 * @param body - The JSON body.
 * @param [init] - More of the request.
 * @returns The answer.
 */
function call(path: string, body: unknown, init: RequestInit = {}): Promise<Response> {
  return forwarder.fetchFor(ATTRIBUTION)(`${MODELS_BASE_URL}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.method === 'POST') {
      received.push({ path: req.originalUrl, headers: req.headers, body: req.body });
    }
    next();
  });
  app.get('/v1/models', (_req, res) => {
    res.json({ data: [{ id: 'qwen3:8b', context_length: 32768 }] });
  });
  app.post('/v1/chat/completions', (req, res) => {
    if (req.body.stream) {
      res.setHeader('content-type', 'text/event-stream');
      res.setHeader('set-cookie', 'stolen=1');
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.end('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\ndata: [DONE]\n\n');
      return;
    }
    res.json({ model: req.body.model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } });
  });
  app.post('/v1/fail', (_req, res) => {
    res.status(429).json({ error: { message: 'slow down' } });
  });
  app.post('/v1/slow', () => {
    // Never answers.
  });
  app.post('/v1/trickle', (_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    setTimeout(() => res.end('data: [DONE]\n\n'), 200);
  });
  app.post('/v1/broken', (_req, res) => {
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: {"choices":[]}\n\n');
    setTimeout(() => res.socket?.destroy(), 20);
  });
  provider = app.listen(0);
  await new Promise<void>((resolve) => provider.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${portOf(provider)}/v1`;
});

afterAll(async () => {
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
});

beforeEach(() => {
  received = [];
  recorded = [];
  balancer = new PoolBalancer();
  const ollama = providerEntry('ollama');
  snapshot = {
    ...EMPTY_SNAPSHOT,
    providers: new Map([
      ['ollama', ollama],
      ['off', providerEntry('off', { enabled: false })],
    ]),
    pools: new Map([
      [
        'qwen3',
        {
          id: 'p1',
          name: 'qwen3',
          enabled: true,
          strategy: PoolStrategy.LeastBusy,
          affinity: AFFINITY_NONE,
          maxLoadFactor: null,
          targets: [{ providerId: ollama.id, providerName: 'ollama', model: 'qwen3:8b', weight: 1 }],
        },
      ],
    ]),
  };
  forwarder = build();
});

describe('forwarding a provider model', () => {
  it('sends the model as the provider names it, with its key and headers, and counts the answer', async () => {
    const answer = await call('chat/completions', { model: 'ollama/qwen3:8b', messages: [] });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ model: 'qwen3:8b' });
    expect(received[0]?.body.model).toBe('qwen3:8b');
    expect(received[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(received[0]?.headers['x-extra']).toBe('yes');
    expect(recorded).toEqual([
      {
        served: { ...ATTRIBUTION, providerId: 'id-ollama', providerName: 'ollama', model: 'qwen3:8b' },
        reported: { inputTokens: 5, outputTokens: 7 },
      },
    ]);
  });

  it('streams through, asking for usage and reading it from the last chunk, and drops set-cookie', async () => {
    const answer = await call('chat/completions', { model: 'ollama/qwen3:8b', messages: [], stream: true });
    expect(answer.headers.get('set-cookie')).toBeNull();
    expect(await answer.text()).toContain('"content":"hi"');
    expect(received[0]?.body.stream_options).toEqual({ include_usage: true });
    expect(recorded[0]?.reported).toEqual({ inputTokens: 11, outputTokens: 2 });
  });

  it("passes a provider error through unchanged, and doesn't count it", async () => {
    const answer = await call('fail', { model: 'ollama/qwen3:8b' });
    expect(answer.status).toBe(429);
    expect(await answer.json()).toEqual({ error: { message: 'slow down' } });
    expect(recorded).toEqual([]);
  });

  it('keeps the query string', async () => {
    await call('chat/completions?api-version=1', { model: 'ollama/qwen3:8b', messages: [] });
    expect(received[0]?.path).toBe('/v1/chat/completions?api-version=1');
  });
});

describe('refusing', () => {
  it.each(['nobody/model', 'off/qwen3:8b', 'no-such-pool'])('answers 404 model_not_found for %s', async (model) => {
    const answer = await call('chat/completions', { model });
    expect(answer.status).toBe(404);
    expect(await answer.json()).toMatchObject({ error: { code: 'model_not_found' } });
    expect(received).toEqual([]);
  });

  it('answers 400 for a body with no model', async () => {
    expect((await call('chat/completions', { messages: [] })).status).toBe(400);
  });

  it('refuses a path that would leave the provider base path', async () => {
    const answer = await forwarder.forward({
      path: 'v1/../admin',
      body: { model: 'ollama/qwen3:8b' },
      attribution: ATTRIBUTION,
    });
    expect(answer.status).toBe(400);
    // Through a run's fetch the URL is normalised first, out of the router's address.
    expect((await call('../admin', { model: 'ollama/qwen3:8b' })).status).toBe(404);
    expect(received).toEqual([]);
  });

  it('answers 502 for a provider that cannot be reached', async () => {
    snapshot = {
      ...snapshot,
      providers: new Map([['dead', providerEntry('dead', { baseUrl: 'http://127.0.0.1:1/v1' })]]),
    };
    const answer = await call('chat/completions', { model: 'dead/x' });
    expect(answer.status).toBe(502);
  });

  it('answers 504 for a provider that does not start answering in time', async () => {
    forwarder = build(SHORT_TIMEOUT_MS);
    const answer = await call('slow', { model: 'ollama/qwen3:8b' });
    expect(answer.status).toBe(504);
    expect(await answer.json()).toMatchObject({ error: { code: 'upstream_timeout' } });
  });

  it('answers only its own address', async () => {
    const answer = await forwarder.fetchFor(ATTRIBUTION)('http://example.com/v1/chat/completions', { method: 'POST' });
    expect(answer.status).toBe(404);
  });
});

describe('pools', () => {
  const target = { providerName: 'ollama', providerId: 'id-ollama', model: 'qwen3:8b', weight: 1 };

  it('sends a pool call to its target, and frees the slot when the answer ends', async () => {
    const answer = await call('chat/completions', { model: 'qwen3', messages: [] });
    expect(received[0]?.body.model).toBe('qwen3:8b');
    expect(balancer.inFlightTo(target)).toBe(1);
    await answer.text();
    expect(balancer.inFlightTo(target)).toBe(0);
  });

  it('frees the slot when the caller abandons the answer', async () => {
    const answer = await call('chat/completions', { model: 'qwen3', messages: [], stream: true });
    await answer.body?.cancel();
    expect(balancer.inFlightTo(target)).toBe(0);
  });

  it('says nothing is wrong when the caller stops reading with the next chunk still on its way', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const answer = await call('trickle', { model: 'qwen3' });
      const reader = answer.body?.getReader();
      await reader?.read();
      // A client waiting on the next chunk when it decides it has heard enough, as the OpenAI SDK does at [DONE].
      const waiting = reader?.read();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await reader?.cancel();
      await waiting;
      // Past the provider's last chunk, which lands on the read that was waiting when the caller cancelled.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(warned).not.toHaveBeenCalled();
      expect(balancer.inFlightTo(target)).toBe(0);
    } finally {
      warned.mockRestore();
    }
  });

  it('frees the slot when the caller gives up without reading the answer', async () => {
    const giveUp = new AbortController();
    await call('chat/completions', { model: 'qwen3', messages: [], stream: true }, { signal: giveUp.signal });
    expect(balancer.inFlightTo(target)).toBe(1);
    giveUp.abort();
    expect(balancer.inFlightTo(target)).toBe(0);
  });

  it('frees the slot when the provider breaks off mid-stream', async () => {
    const answer = await call('broken', { model: 'qwen3' });
    await expect(answer.text()).rejects.toThrow();
    expect(balancer.inFlightTo(target)).toBe(0);
  });

  it('frees the slot when the provider cannot be reached', async () => {
    const dead = providerEntry('ollama', { baseUrl: 'http://127.0.0.1:1/v1' });
    snapshot = { ...snapshot, providers: new Map([['ollama', dead]]) };
    expect((await call('chat/completions', { model: 'qwen3' })).status).toBe(502);
    expect(balancer.inFlightTo(target)).toBe(0);
  });

  describe('with a target that cannot be reached', () => {
    const deadTarget = { providerName: 'dead', providerId: 'id-dead', model: 'qwen3:8b', weight: 1 };

    beforeEach(() => {
      const dead = providerEntry('dead', { baseUrl: 'http://127.0.0.1:1/v1' });
      snapshot = {
        ...snapshot,
        providers: new Map([...snapshot.providers, ['dead', dead]]),
        // Round-robin, the dead target first: every first call goes to it, unless it is passed over.
        pools: new Map([
          [
            'qwen3',
            {
              id: 'p1',
              name: 'qwen3',
              enabled: true,
              strategy: PoolStrategy.RoundRobin,
              affinity: AFFINITY_NONE,
              maxLoadFactor: null,
              targets: [deadTarget, target],
            },
          ],
        ]),
      };
    });

    it("sends the call to the pool's next target, and passes the dead one over after", async () => {
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const first = await call('chat/completions', { model: 'qwen3', messages: [] });
        expect(first.status).toBe(200);
        await first.text();
        expect(balancer.isReachable(deadTarget)).toBe(false);
        expect(balancer.inFlightTo(deadTarget)).toBe(0);
        expect(recorded.map((entry) => entry.served.providerName)).toEqual(['ollama']);
        const second = await call('chat/completions', { model: 'qwen3', messages: [] });
        await second.text();
        expect(received).toHaveLength(2);
        expect(warned).toHaveBeenCalledTimes(1);
      } finally {
        warned.mockRestore();
      }
    });

    it('answers 502 when no target of the pool can be reached', async () => {
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const dead = providerEntry('ollama', { baseUrl: 'http://127.0.0.1:1/v1' });
        snapshot = { ...snapshot, providers: new Map([...snapshot.providers, ['ollama', dead]]) };
        const answer = await call('chat/completions', { model: 'qwen3' });
        expect(answer.status).toBe(502);
        expect(await answer.json()).toMatchObject({ error: { code: 'upstream_failed' } });
        expect(balancer.inFlightTo(target)).toBe(0);
      } finally {
        warned.mockRestore();
      }
    });

    it('does not retry a target that answered with an error', async () => {
      const answer = await call('fail', { model: 'ollama/qwen3:8b' });
      expect(answer.status).toBe(429);
      expect(received).toHaveLength(1);
    });
  });

  it('answers 503 for a pool whose providers are all off', async () => {
    snapshot = { ...snapshot, providers: new Map([['ollama', providerEntry('ollama', { enabled: false })]]) };
    expect((await call('chat/completions', { model: 'qwen3' })).status).toBe(503);
  });
});

describe('listing', () => {
  it('lists pools first, then each provider model as <provider>/<model>, keeping what the provider said', async () => {
    const answer = await forwarder.fetchFor(ATTRIBUTION)(`${MODELS_BASE_URL}/models`);
    const { data } = await answer.json();
    expect(data).toEqual([
      { id: 'qwen3', object: 'model', created: 0, owned_by: 'pool' },
      { id: 'ollama/qwen3:8b', object: 'model', created: 0, owned_by: 'ollama', context_length: 32768 },
    ]);
  });

  it('leaves out a provider it cannot list', async () => {
    snapshot = {
      ...snapshot,
      providers: new Map([['dead', providerEntry('dead', { baseUrl: 'http://127.0.0.1:1/v1' })]]),
    };
    const { data } = await (await forwarder.listModels()).json();
    expect(data).toEqual([]);
  });
});
