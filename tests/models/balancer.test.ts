import { describe, expect, it } from 'vitest';
import type { SnapshotPool, SnapshotTarget } from '../../server/db/snapshot.ts';
import { AFFINITY_NONE, AFFINITY_STICKY, PoolStrategy } from '../../server/db/tables/pools.ts';
import { PoolBalancer } from '../../server/models/balancer.ts';

const CANDIDATES: SnapshotTarget[] = ['gpu-a', 'gpu-b', 'gpu-c'].map((name) => ({
  providerId: `id-${name}`,
  providerName: name,
  model: 'llama',
  weight: 1,
}));
const GPU_A = CANDIDATES[0];

/** Many affinity keys, so a share of them can be counted. */
const KEYS = Array.from({ length: 600 }, (_, index) => `chat-${index}`);

/**
 * Gives the three test candidates weights.
 *
 * @param weights - One weight per candidate, in order.
 * @returns The candidates with those weights.
 */
function weighted(...weights: number[]): SnapshotTarget[] {
  return CANDIDATES.map((candidate, index) => ({ ...candidate, weight: weights[index] ?? 1 }));
}

/**
 * Counts how many of the calls each provider took.
 *
 * @param picked - The provider each call went to.
 * @returns The count per provider.
 */
function countOf(picked: readonly string[]): Record<string, number> {
  return Object.fromEntries(['gpu-a', 'gpu-b', 'gpu-c'].map((name) => [name, picked.filter((p) => p === name).length]));
}

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

  it('takes the targets in turn by weight for round-robin, spread rather than in a run', () => {
    const config = pool({ strategy: PoolStrategy.RoundRobin });
    const picked = place(new PoolBalancer(), config, Array(8).fill(null), weighted(2, 1, 1));
    expect(picked).toEqual(['gpu-a', 'gpu-b', 'gpu-c', 'gpu-a', 'gpu-a', 'gpu-b', 'gpu-c', 'gpu-a']);
  });

  it('starts round-robin over when a weight changes', () => {
    const balancer = new PoolBalancer();
    const config = pool({ strategy: PoolStrategy.RoundRobin });
    place(balancer, config, [null], weighted(3, 1, 1));
    expect(place(balancer, config, [null, null, null])).toEqual(['gpu-a', 'gpu-b', 'gpu-c']);
  });

  it('compares load per unit of weight for least-busy', () => {
    const balancer = new PoolBalancer();
    const candidates = weighted(2, 1, 1);
    const picked = place(balancer, pool(), [null, null, null, null], candidates);
    expect(picked).toEqual(['gpu-a', 'gpu-b', 'gpu-c', 'gpu-a']);
    expect(balancer.acquire(pool(), candidates, null).providerName).toBe('gpu-a');
    expect(balancer.inFlightTo(GPU_A)).toBe(3);
  });

  it('picks by the random number over the weights for random', () => {
    const config = pool({ strategy: PoolStrategy.Random });
    const pick = (fraction: number) => new PoolBalancer(() => fraction).acquire(config, weighted(2, 1, 1), null);
    expect([0, 0.49, 0.5, 0.74, 0.75, 0.99].map((fraction) => pick(fraction).providerName)).toEqual([
      'gpu-a',
      'gpu-a',
      'gpu-b',
      'gpu-b',
      'gpu-c',
      'gpu-c',
    ]);
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

  it('gives a target a share of the keys by its weight', () => {
    const counts = countOf(place(new PoolBalancer(), sticky(), KEYS, weighted(4, 1, 1)));
    expect(counts['gpu-a']).toBeGreaterThan(2 * Math.max(counts['gpu-b'] ?? 0, counts['gpu-c'] ?? 0));
  });

  it('moves only the keys of a weighted target that leaves', () => {
    const candidates = weighted(3, 2, 1);
    const before = KEYS.map((key) => new PoolBalancer().acquire(sticky(), candidates, key).providerName);
    const withoutB = candidates.filter((candidate) => candidate.providerName !== 'gpu-b');
    const after = KEYS.map((key) => new PoolBalancer().acquire(sticky(), withoutB, key).providerName);
    const moved = KEYS.filter((_, index) => before[index] !== after[index]);
    expect(moved).toEqual(KEYS.filter((_, index) => before[index] === 'gpu-b'));
  });

  it('moves keys only onto a target whose weight goes up', () => {
    const before = KEYS.map((key) => new PoolBalancer().acquire(sticky(), weighted(1, 1, 1), key).providerName);
    const after = KEYS.map((key) => new PoolBalancer().acquire(sticky(), weighted(1, 1, 3), key).providerName);
    const movedTo = new Set(after.filter((name, index) => name !== before[index]));
    expect(movedTo).toEqual(new Set(['gpu-c']));
  });

  it('bounds a weighted target by its share of the load', () => {
    const balancer = new PoolBalancer();
    const candidates = weighted(2, 1, 1);
    place(balancer, sticky({ maxLoadFactor: 1 }), Array(8).fill('chat-1'), candidates);
    expect(candidates.map((candidate) => balancer.inFlightTo(candidate))).toEqual([4, 2, 2]);
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

describe('PoolBalancer unreachable targets', () => {
  const COOLDOWN_SECONDS = 30;
  const COOLDOWN_MS = COOLDOWN_SECONDS * 1000;

  it('passes over a target it could not reach, until the cooldown ends', () => {
    let now = 0;
    const balancer = new PoolBalancer(Math.random, () => now, COOLDOWN_SECONDS);
    const config = pool({ strategy: PoolStrategy.RoundRobin });
    balancer.markUnreachable(GPU_A, 'connection refused');
    expect(place(balancer, config, [null, null, null])).toEqual(['gpu-b', 'gpu-c', 'gpu-b']);
    now = COOLDOWN_MS;
    expect(balancer.isReachable(GPU_A)).toBe(true);
  });

  it('still offers calls when no target can be reached', () => {
    const balancer = new PoolBalancer(Math.random, () => 0, COOLDOWN_SECONDS);
    for (const candidate of CANDIDATES) {
      balancer.markUnreachable(candidate, 'connection refused');
    }
    expect(place(balancer, pool(), [null])).toEqual(['gpu-a']);
  });

  it('passes the target over in every pool that has it', () => {
    const balancer = new PoolBalancer(Math.random, () => 0, COOLDOWN_SECONDS);
    balancer.markUnreachable(GPU_A, 'connection refused');
    expect(place(balancer, pool({ id: 'other', strategy: PoolStrategy.RoundRobin }), [null])).toEqual(['gpu-b']);
  });
});

describe('PoolBalancer health checks', () => {
  const CHECKED_AT = Date.parse('2026-11-18T12:00:00Z');
  const down = (target: SnapshotTarget) => ({ target, downReason: 'gpu-a does not list llama.' });
  const up = (target: SnapshotTarget) => ({ target, downReason: null });

  it('passes over a target a check found down, until a later check finds it up', () => {
    const balancer = new PoolBalancer(Math.random, () => CHECKED_AT);
    const config = pool({ strategy: PoolStrategy.RoundRobin });
    balancer.recordChecks([down(GPU_A), ...CANDIDATES.slice(1).map(up)]);
    expect(place(balancer, config, [null, null])).toEqual(['gpu-b', 'gpu-c']);
    expect(balancer.healthOf(GPU_A)).toEqual({
      reachable: false,
      checkedAt: new Date(CHECKED_AT),
      downReason: 'gpu-a does not list llama.',
    });
    balancer.recordChecks(CANDIDATES.map(up));
    expect(balancer.healthOf(GPU_A)).toEqual({ reachable: true, checkedAt: new Date(CHECKED_AT), downReason: null });
  });

  it('forgets a target the last round left out', () => {
    const balancer = new PoolBalancer(Math.random, () => CHECKED_AT);
    balancer.recordChecks([down(GPU_A)]);
    balancer.recordChecks([]);
    expect(balancer.healthOf(GPU_A)).toEqual({ reachable: true, checkedAt: null, downReason: null });
  });

  it("says a call's failure first, while it cools down, then the check's", () => {
    let now = CHECKED_AT;
    const balancer = new PoolBalancer(Math.random, () => now, 1);
    balancer.recordChecks([up(GPU_A)]);
    balancer.markUnreachable(GPU_A, 'connection refused');
    expect(balancer.healthOf(GPU_A)).toMatchObject({ reachable: false, downReason: 'connection refused' });
    now += 1000;
    expect(balancer.healthOf(GPU_A)).toMatchObject({ reachable: true, downReason: null });
  });

  it('still offers calls when the checks found every target down', () => {
    const balancer = new PoolBalancer(Math.random, () => CHECKED_AT);
    balancer.recordChecks(CANDIDATES.map(down));
    expect(place(balancer, pool(), [null])).toEqual(['gpu-a']);
  });
});
