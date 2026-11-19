import { beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_SNAPSHOT,
  type Snapshot,
  type SnapshotPool,
  type SnapshotProvider,
  type SnapshotTarget,
} from '../../server/db/snapshot.ts';
import { AFFINITY_NONE, PoolStrategy } from '../../server/db/tables/pools.ts';
import { PoolBalancer } from '../../server/models/balancer.ts';
import { ModelCatalog } from '../../server/models/catalog.ts';
import { createPoolHealthChecker, type PoolHealthChecker } from '../../server/models/health.ts';
import type { UpstreamFetch } from '../../server/models/outbound.ts';

const CHECKED_AT = Date.parse('2026-11-18T12:00:00Z');
/** Long enough that no timer fires during a test: rounds are driven by `check`. */
const NEVER_SECONDS = 3_600;

/**
 * Builds a provider entry.
 *
 * @param name - Its name, also its host.
 * @param [enabled] - Whether it is on.
 * @returns The provider.
 */
function providerEntry(name: string, enabled = true): SnapshotProvider {
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

/**
 * Builds a target.
 *
 * @param providerName - Its provider.
 * @param model - The model's id there.
 * @returns The target.
 */
function targetOf(providerName: string, model: string): SnapshotTarget {
  return { providerId: `id-${providerName}`, providerName, model, weight: 1 };
}

/**
 * Builds a pool entry.
 *
 * @param name - Its name.
 * @param targets - Its targets.
 * @param [enabled] - Whether it is on.
 * @returns The pool.
 */
function poolEntry(name: string, targets: SnapshotTarget[], enabled = true): SnapshotPool {
  return {
    id: `id-${name}`,
    name,
    enabled,
    strategy: PoolStrategy.RoundRobin,
    affinity: AFFINITY_NONE,
    maxLoadFactor: null,
    targets,
  };
}

const QWEN = targetOf('ollama', 'qwen3:8b');
const LLAMA = targetOf('ollama', 'llama3');
const MISSING = targetOf('ollama', 'missing');
const GPU = targetOf('gpu', 'qwen3:8b');
const BEHIND_OFF_PROVIDER = targetOf('off', 'qwen3:8b');
const IN_OFF_POOL = targetOf('ollama', 'in-off-pool');
const SHARED = poolEntry('shared', [QWEN, GPU]);

const SNAPSHOT: Snapshot = {
  ...EMPTY_SNAPSHOT,
  providers: new Map(['ollama', 'gpu'].map((name) => [name, providerEntry(name)])).set(
    'off',
    providerEntry('off', false),
  ),
  pools: new Map([
    ['qwen3', poolEntry('qwen3', [QWEN, LLAMA, MISSING, GPU, BEHIND_OFF_PROVIDER])],
    ['shared', SHARED],
    ['off', poolEntry('off', [IN_OFF_POOL], false)],
  ]),
};

describe('the pool health checker', () => {
  let asked: string[];
  let isGpuUp: boolean;
  let balancer: PoolBalancer;
  let checker: PoolHealthChecker;

  beforeEach(() => {
    asked = [];
    isGpuUp = false;
    const fetch: UpstreamFetch = async (url) => {
      asked.push(url);
      const isGpu = url.startsWith('http://gpu/');
      if (isGpu && isGpuUp === false) {
        throw new Error('connection refused');
      }
      const ids = isGpu ? ['qwen3:8b'] : ['qwen3:8b', 'llama3:latest'];
      const text = JSON.stringify({ data: ids.map((id) => ({ id })) });
      return { status: 200, ok: true, headers: new Headers(), body: null, text: async () => text };
    };
    balancer = new PoolBalancer(Math.random, () => CHECKED_AT);
    checker = createPoolHealthChecker(
      { snapshot: { current: () => SNAPSHOT, rebuild: async () => {} }, balancer, catalog: new ModelCatalog(fetch) },
      { intervalSeconds: NEVER_SECONDS },
    );
  });

  it('asks each provider an enabled pool uses once a round, however many targets and pools share it', async () => {
    await checker.check();
    expect(asked.sort()).toEqual(['http://gpu/v1/models', 'http://ollama/v1/models']);
  });

  it("passes over a target whose provider can't be listed, or doesn't list its model", async () => {
    await checker.check();
    expect(balancer.healthOf(GPU)).toEqual({
      reachable: false,
      checkedAt: new Date(CHECKED_AT),
      downReason: expect.stringContaining('connection refused'),
    });
    expect(balancer.healthOf(MISSING)).toMatchObject({ reachable: false, downReason: 'ollama does not list missing.' });
    expect(balancer.healthOf(QWEN)).toEqual({ reachable: true, checkedAt: new Date(CHECKED_AT), downReason: null });
  });

  it('counts a model Ollama lists with its default tag as listed', async () => {
    await checker.check();
    expect(balancer.healthOf(LLAMA)).toMatchObject({ reachable: true, downReason: null });
  });

  it('passes the target over before a call finds it down', async () => {
    await checker.check();
    const picked = [0, 1, 2].map(() => balancer.acquire(SHARED, SHARED.targets, null).providerName);
    expect(picked).toEqual(['ollama', 'ollama', 'ollama']);
  });

  it('brings a target back once a later round finds it up', async () => {
    await checker.check();
    isGpuUp = true;
    await checker.check();
    expect(balancer.healthOf(GPU)).toMatchObject({ reachable: true, downReason: null });
  });

  it("leaves out a disabled pool's targets and a disabled provider's", async () => {
    await checker.check();
    expect(balancer.healthOf(IN_OFF_POOL).checkedAt).toBeNull();
    expect(balancer.healthOf(BEHIND_OFF_PROVIDER).checkedAt).toBeNull();
  });

  it('shares a round still running with a second call', async () => {
    await Promise.all([checker.check(), checker.check()]);
    expect(asked).toHaveLength(2);
  });

  it('runs a round as soon as it starts', async () => {
    checker.start();
    try {
      await checker.check();
      expect(asked).toHaveLength(2);
    } finally {
      checker.stop();
    }
  });
});
