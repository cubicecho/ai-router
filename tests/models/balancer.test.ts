import { describe, expect, it } from 'vitest';
import type { SnapshotPool, SnapshotTarget } from '../../server/db/snapshot.ts';
import { AFFINITY_NONE, AFFINITY_STICKY, PoolStrategy } from '../../server/db/tables/pools.ts';
import { PoolBalancer } from '../../server/models/balancer.ts';

const CANDIDATES: SnapshotTarget[] = ['gpu-a', 'gpu-b', 'gpu-c'].map((name) => ({
  providerId: `id-${name}`,
  providerName: name,
  model: 'llama',
}));
const GPU_A = CANDIDATES[0];

/**
 * Builds a pool over the three test candidates.
 *
 * @param overrides - Fields that differ from a least-busy pool with no affinity.
 * @returns The pool.
 */
function pool(overrides: Partial<SnapshotPool> = {}): SnapshotPool {
  return {
    id: 'pool-1',
    name: 'llama',
    enabled: true,
    strategy: PoolStrategy.LeastBusy,
    affinity: AFFINITY_NONE,
    maxLoadFactor: null,
    targets: CANDIDATES,
    ...overrides,
  };
}

/**
 * Places calls and keeps their leases open.
 *
 * @param balancer - The balancer.
 * @param config - The pool.
 * @param keys - One affinity key per call; null for none.
 * @param [candidates] - The candidates.
 * @returns The provider each call went to.
 */
function place(
  balancer: PoolBalancer,
  config: SnapshotPool,
  keys: readonly (string | null)[],
  candidates: readonly SnapshotTarget[] = CANDIDATES,
): string[] {
  return keys.map((key) => balancer.acquire(config, candidates, key).providerName);
}

describe('PoolBalancer strategies', () => {
  it('takes the targets in turn for round-robin', () => {
    const picked = place(new PoolBalancer(), pool({ strategy: PoolStrategy.RoundRobin }), [null, null, null, null]);
    expect(picked).toEqual(['gpu-a', 'gpu-b', 'gpu-c', 'gpu-a']);
  });

  it('starts round-robin over when the targets change', () => {
    const balancer = new PoolBalancer();
    const config = pool({ strategy: PoolStrategy.RoundRobin });
    place(balancer, config, [null, null]);
    const fewer = CANDIDATES.slice(0, 2);
    expect(place(balancer, config, [null, null, null], fewer)).toEqual(['gpu-a', 'gpu-b', 'gpu-a']);
  });

  it('spreads open calls over the least busy target, earliest first on a tie', () => {
    const balancer = new PoolBalancer();
    const config = pool();
    const first = balancer.acquire(config, CANDIDATES, null);
    place(balancer, config, [null, null]);
    first.release();
    expect(balancer.acquire(config, CANDIDATES, null).providerName).toBe('gpu-a');
  });

  it('picks by the random number for random', () => {
    expect(place(new PoolBalancer(() => 0.7), pool({ strategy: PoolStrategy.Random }), [null])).toEqual(['gpu-c']);
  });

  it('throws when the pool has no candidate', () => {
    expect(() => new PoolBalancer().acquire(pool(), [], null)).toThrow(/no target/);
  });
});

describe('PoolBalancer in-flight counts', () => {
  it('counts a lease until it is released, once', () => {
    const balancer = new PoolBalancer();
    const lease = balancer.acquire(pool(), CANDIDATES, null);
    expect(balancer.inFlightTo(GPU_A)).toBe(1);
    lease.release();
    lease.release();
    expect(balancer.inFlightTo(GPU_A)).toBe(0);
  });

  it('shares one target count between pools that share the target', () => {
    const balancer = new PoolBalancer();
    balancer.acquire(pool({ id: 'one' }), CANDIDATES.slice(0, 1), null);
    balancer.acquire(pool({ id: 'two' }), CANDIDATES.slice(0, 1), null);
    expect(balancer.inFlightTo(GPU_A)).toBe(2);
  });
});

describe('PoolBalancer sticky affinity', () => {
  const sticky = (overrides: Partial<SnapshotPool> = {}) => pool({ affinity: AFFINITY_STICKY, ...overrides });

  it('sends every call with the same key to the same target, whatever the load', () => {
    expect(new Set(place(new PoolBalancer(), sticky(), ['chat-1', 'chat-1', 'chat-1', 'chat-1'])).size).toBe(1);
  });

  it('spreads different keys over the targets', () => {
    const keys = Array.from({ length: 60 }, (_, index) => `chat-${index}`);
    expect(new Set(place(new PoolBalancer(), sticky(), keys))).toEqual(new Set(['gpu-a', 'gpu-b', 'gpu-c']));
  });

  it('moves only the keys of a target that leaves', () => {
    const keys = Array.from({ length: 60 }, (_, index) => `chat-${index}`);
    const before = keys.map((key) => new PoolBalancer().acquire(sticky(), CANDIDATES, key).providerName);
    const withoutC = CANDIDATES.filter((candidate) => candidate.providerName !== 'gpu-c');
    const after = keys.map((key) => new PoolBalancer().acquire(sticky(), withoutC, key).providerName);
    const moved = keys.filter((_, index) => before[index] !== after[index]);
    const movedFromC = keys.filter((_, index) => before[index] === 'gpu-c');
    expect(moved).toEqual(movedFromC);
  });

  it('uses the strategy for a call without a key', () => {
    expect(place(new PoolBalancer(), sticky({ strategy: PoolStrategy.RoundRobin }), [null, null])).toEqual([
      'gpu-a',
      'gpu-b',
    ]);
  });

  it('passes over a target that bounded load says is full, to the next in the key ranking', () => {
    expect(new Set(place(new PoolBalancer(), sticky({ maxLoadFactor: 1 }), ['chat-1', 'chat-1', 'chat-1'])).size).toBe(
      3,
    );
  });

  it('keeps a key on its own target while that target is under the bound', () => {
    const [first, second] = place(new PoolBalancer(), sticky({ maxLoadFactor: 2 }), ['chat-1', 'chat-1']);
    expect(second).toBe(first);
  });
});
