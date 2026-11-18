import { createHash } from 'node:crypto';
import type { SnapshotPool, SnapshotTarget } from '../db/snapshot.ts';
import { AFFINITY_STICKY, PoolStrategy } from '../db/tables/pools.ts';
import { modelId } from './naming.ts';

/** Bytes of a hash read as a target's score: six fit a safe integer. */
const SCORE_BYTES = 6;

/** The target picked for one call. Its in-flight slot is held until `release` is called. */
export interface PoolLease extends SnapshotTarget {
  /** Frees the slot; calling it again does nothing. */
  release: () => void;
}

/** What a strategy reads to pick a candidate. */
interface StrategyInput {
  /** The calls in flight to each candidate, in candidate order. */
  loads: readonly number[];
  /** How many calls this pool's round-robin has placed before this one, over these candidates. */
  turn: number;
  /** A number in [0, 1). */
  random: () => number;
}

/** Picks a candidate by its index. */
type Strategy = (input: StrategyInput) => number;

/** How each strategy picks, given at least one candidate. */
const PICK_BY_STRATEGY = {
  [PoolStrategy.RoundRobin]: ({ loads, turn }) => turn % loads.length,
  [PoolStrategy.LeastBusy]: ({ loads }) => loads.indexOf(Math.min(...loads)),
  [PoolStrategy.Random]: ({ loads, random }) => Math.floor(random() * loads.length),
} satisfies Record<PoolStrategy, Strategy>;

/** A pool's round-robin position, and the candidates it counts over. */
interface Turn {
  /** The candidates' ids, joined. A different set starts the count again. */
  over: string;
  next: number;
}

/**
 * Scores a target for a key; the same pair always scores the same.
 *
 * @param key - The call's affinity key.
 * @param targetId - The target's model id.
 * @returns A whole number; the highest-scoring target is the key's own.
 */
function rendezvousScore(key: string, targetId: string): number {
  return createHash('sha256').update(key).update('\n').update(targetId).digest().readUIntBE(0, SCORE_BYTES);
}

/**
 * Names a target as an agent would name it directly.
 *
 * @param target - The target.
 * @returns `<provider>/<model>`.
 */
function targetId(target: SnapshotTarget): string {
  return modelId(target.providerName, target.model);
}

/**
 * Picks which of a pool's targets serves each call, and counts the calls each target has in flight.
 *
 * @remarks
 * A sticky call goes to the target its key ranks highest (rendezvous hashing), so a target leaving moves only its
 * own keys. With bounded load on, a target over `maxLoadFactor` times the average is passed over for the next in the
 * key's ranking. Counts are per target, so pools that share a target share its count: it is one server's load.
 */
export class PoolBalancer {
  private readonly inFlight = new Map<string, number>();
  private readonly turns = new Map<string, Turn>();
  private readonly random: () => number;

  /**
   * Builds a balancer with nothing in flight.
   *
   * @param [random] - Returns a number in [0, 1); the random strategy reads it.
   */
  constructor(random: () => number = Math.random) {
    this.random = random;
  }

  /**
   * Picks the target for one call and holds a slot on it.
   *
   * @param pool - The pool the call named.
   * @param candidates - Its targets whose provider is enabled, in the pool's order.
   * @param key - The call's affinity key; null when it has none.
   * @returns The target, with `release` to call when the answer ends.
   * @throws When there is no candidate: the caller answers that case itself.
   */
  acquire(pool: SnapshotPool, candidates: readonly SnapshotTarget[], key: string | null): PoolLease {
    const loads = candidates.map((candidate) => this.inFlightTo(candidate));
    const isSticky = pool.affinity === AFFINITY_STICKY && key !== null;
    const index = isSticky
      ? this.pickSticky(pool, candidates, loads, key)
      : this.pickByStrategy(pool, candidates, loads);
    const chosen = candidates[index];
    if (chosen === undefined) {
      throw new Error(`Pool "${pool.name}" has no target to send a call to.`);
    }
    return this.hold(chosen);
  }

  /**
   * Counts the calls in flight to one target.
   *
   * @param target - The target.
   * @returns The calls sent to it that have not finished.
   */
  inFlightTo(target: SnapshotTarget): number {
    return this.inFlight.get(targetId(target)) ?? 0;
  }

  /**
   * Picks by the pool's strategy.
   *
   * @param pool - The pool.
   * @param candidates - The candidates, for the round-robin's count.
   * @param loads - The calls in flight to each candidate.
   * @returns The candidate's index.
   */
  private pickByStrategy(pool: SnapshotPool, candidates: readonly SnapshotTarget[], loads: readonly number[]): number {
    const over = candidates.map(targetId).join('\n');
    const kept = this.turns.get(pool.id);
    // llm-router kept counting across a change of targets, so the turn pointed somewhere arbitrary.
    const turn = kept?.over === over ? kept.next : 0;
    if (pool.strategy === PoolStrategy.RoundRobin) {
      this.turns.set(pool.id, { over, next: turn + 1 });
    }
    return PICK_BY_STRATEGY[pool.strategy]({ loads, turn, random: this.random });
  }

  /**
   * Picks the candidate the key ranks highest, passing over one that bounded load says is full.
   *
   * @param pool - The pool, for its `maxLoadFactor`.
   * @param candidates - The candidates.
   * @param loads - The calls in flight to each candidate.
   * @param key - The call's affinity key.
   * @returns The candidate's index.
   */
  private pickSticky(
    pool: SnapshotPool,
    candidates: readonly SnapshotTarget[],
    loads: readonly number[],
    key: string,
  ): number {
    const ranked = candidates
      .map((candidate, index) => ({ index, score: rendezvousScore(key, targetId(candidate)) }))
      .sort((a, b) => b.score - a.score);
    const factor = pool.maxLoadFactor;
    if (factor === null) {
      return ranked[0]?.index ?? 0;
    }
    // Counting this call, no target may hold more than `factor` times the average. One always has room.
    const total = loads.reduce((sum, load) => sum + load, 0);
    const capacity = Math.ceil((factor * (total + 1)) / candidates.length);
    const withRoom = ranked.find(({ index }) => (loads[index] ?? 0) < capacity);
    return withRoom?.index ?? 0;
  }

  /**
   * Counts a call against a target until it is released.
   *
   * @param target - The target.
   * @returns The lease on it.
   */
  private hold(target: SnapshotTarget): PoolLease {
    const id = targetId(target);
    this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1);
    let isHeld = true;
    const release = (): void => {
      if (isHeld) {
        isHeld = false;
        const remaining = (this.inFlight.get(id) ?? 1) - 1;
        if (remaining > 0) {
          this.inFlight.set(id, remaining);
        } else {
          this.inFlight.delete(id);
        }
      }
    };
    return { ...target, release };
  }
}
