import { createHash } from 'node:crypto';
import { MODEL_DEFAULTS } from '../core/defaults.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import type { SnapshotPool, SnapshotTarget } from '../db/snapshot.ts';
import { EQUAL_WEIGHT } from '../db/tables/pool-targets.ts';
import { AFFINITY_STICKY, PoolStrategy } from '../db/tables/pools.ts';
import { modelId } from './naming.ts';

/** Bytes of a hash read as a target's score: six fit a safe integer. */
const SCORE_BYTES = 6;
/** How many values one byte holds. */
const BYTE_VALUES = 256;
/** How many values a score's bytes hold, so a score over it is a fraction in [0, 1). */
const SCORE_RANGE = BYTE_VALUES ** SCORE_BYTES;
/** Moves a score's fraction off 0, whose logarithm has no end: every fraction is then in (0, 1). */
const HALF_STEP = 0.5;

/** The target picked for one call. Its in-flight slot is held until `release` is called. */
export interface PoolLease extends SnapshotTarget {
  /** Frees the slot; calling it again does nothing. */
  release: () => void;
}

/** One target's result from a round of health checks. */
export interface TargetCheck {
  target: SnapshotTarget;
  /** Why the check found it down; null when it passed. */
  downReason: string | null;
}

/** What the router knows of a target's health right now. */
export interface TargetHealth {
  /** false while it is passed over, by every pool that has it. */
  reachable: boolean;
  /** When a health check last looked at it; null before the first. */
  checkedAt: Date | null;
  /** Why it is passed over; null while it is reachable. */
  downReason: string | null;
}

/** What a strategy reads to pick a candidate. */
interface StrategyInput {
  /** The calls in flight to each candidate, in candidate order. */
  loads: readonly number[];
  /** Each candidate's weight, at least 1. */
  weights: readonly number[];
  /** Round-robin's credit for each candidate, from the calls it placed before this one over these candidates. */
  credits: readonly number[];
  /** A number in [0, 1). */
  random: () => number;
}

/** Picks a candidate by its index. */
type Strategy = (input: StrategyInput) => number;

/**
 * Finds where a number falls when each candidate holds a stretch as long as its weight.
 *
 * @param weights - Each candidate's weight.
 * @param fraction - A number in [0, 1).
 * @returns The index of the candidate whose stretch holds it.
 */
function weightedIndex(weights: readonly number[], fraction: number): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let left = fraction * total;
  const found = weights.findIndex((weight) => {
    left -= weight;
    return left < 0;
  });
  return found === -1 ? weights.length - 1 : found;
}

/**
 * How each strategy picks, given at least one candidate. Each gives a candidate calls in proportion to its weight.
 *
 * @remarks
 * Round-robin is smooth weighted round-robin, as nginx does it: each turn every candidate gains its weight in credit,
 * the richest is picked and pays the total back. Weights 2 and 1 place a, b, a, not a, a, b. Ties go to the earliest.
 */
const PICK_BY_STRATEGY = {
  [PoolStrategy.RoundRobin]: ({ weights, credits }) => {
    const raised = weights.map((weight, index) => (credits[index] ?? 0) + weight);
    return raised.indexOf(Math.max(...raised));
  },
  [PoolStrategy.LeastBusy]: ({ loads, weights }) => {
    // Load per unit of weight, so a target of weight 2 holds twice the calls before it is the busier.
    const perWeight = loads.map((load, index) => load / (weights[index] ?? EQUAL_WEIGHT));
    return perWeight.indexOf(Math.min(...perWeight));
  },
  [PoolStrategy.Random]: ({ weights, random }) => weightedIndex(weights, random()),
} satisfies Record<PoolStrategy, Strategy>;

/** A pool's round-robin position, and the candidates it counts over. */
interface Turn {
  /** The candidates' ids and weights, joined. A different set starts the count again. */
  over: string;
  /** Each candidate's credit, in candidate order. */
  credits: readonly number[];
}

/** A target a call could not reach, passed over until its cooldown ends. */
interface CallFailure {
  /** In epoch milliseconds. */
  until: number;
  reason: string;
}

/** What the last round of health checks found of one target. */
interface CheckResult {
  /** In epoch milliseconds. */
  checkedAt: number;
  downReason: string | null;
}

/**
 * Scores a target for a key, by weighted rendezvous hashing; the same key, target and weight always score the same.
 *
 * @param key - The call's affinity key.
 * @param target - The target.
 * @returns A positive number; the highest-scoring target is the key's own.
 *
 * @remarks
 * The hash, read as a fraction `u` in (0, 1), scores `weight / -ln(u)`, so a target wins a share of the keys in
 * proportion to its weight. Each target's score depends on it alone, so a target leaving moves only its own keys.
 * At equal weights the order is the hash's order.
 */
function rendezvousScore(key: string, target: SnapshotTarget): number {
  const hash = createHash('sha256').update(key).update('\n').update(targetId(target)).digest();
  const fraction = (hash.readUIntBE(0, SCORE_BYTES) + HALF_STEP) / SCORE_RANGE;
  return target.weight / -Math.log(fraction);
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
 * Picks which of a pool's targets serves each call, counts the calls each target has in flight, and keeps which
 * targets are down.
 *
 * @remarks
 * A sticky call goes to the target its key ranks highest (weighted rendezvous hashing), so a target leaving moves
 * only its own keys. With bounded load on, a target over `maxLoadFactor` times its weighted share is passed over for
 * the next in the key's ranking. Counts are per target, so pools that share a target share its count: it is one
 * server's load. A target a call could not reach is passed over for a while, and one the health checks found down
 * until a check passes, by every pool, unless none of a pool's targets is reachable.
 */
export class PoolBalancer {
  private readonly inFlight = new Map<string, number>();
  private readonly turns = new Map<string, Turn>();
  /** Targets a call could not reach lately. */
  private readonly callFailures = new Map<string, CallFailure>();
  /** The last round of health checks, by target. */
  private checks = new Map<string, CheckResult>();
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly cooldownMs: number;

  /**
   * Builds a balancer with nothing in flight.
   *
   * @param [random] - Returns a number in [0, 1); the random strategy reads it.
   * @param [now] - The clock, in epoch milliseconds.
   * @param [cooldownSeconds] - How long a target that could not be reached is passed over.
   */
  constructor(
    random: () => number = Math.random,
    now: () => number = Date.now,
    cooldownSeconds = MODEL_DEFAULTS.unreachableCooldownSeconds,
  ) {
    this.random = random;
    this.now = now;
    this.cooldownMs = cooldownSeconds * MS_PER_SECOND;
  }

  /**
   * Picks the target for one call and holds a slot on it.
   *
   * @param pool - The pool the call named.
   * @param offered - Its targets whose provider is enabled, in the pool's order. Those that are down are passed
   * over, unless that leaves none.
   * @param key - The call's affinity key; null when it has none.
   * @returns The target, with `release` to call when the answer ends.
   * @throws When there is no candidate: the caller answers that case itself.
   */
  acquire(pool: SnapshotPool, offered: readonly SnapshotTarget[], key: string | null): PoolLease {
    const reachable = offered.filter((target) => this.isReachable(target));
    const candidates = reachable.length === 0 ? offered : reachable;
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
   * Passes over a target for a while, since a call could not reach it.
   *
   * @param target - The target.
   * @param reason - Why the call failed, for the pool page.
   */
  markUnreachable(target: SnapshotTarget, reason: string): void {
    this.callFailures.set(targetId(target), { until: this.now() + this.cooldownMs, reason });
  }

  /**
   * Takes a round of health checks: a target found down is passed over until a later round finds it up.
   *
   * @param results - Every target the round looked at. A target it left out has no check result any more.
   */
  recordChecks(results: readonly TargetCheck[]): void {
    const checkedAt = this.now();
    this.checks = new Map(
      results.map(({ target, downReason }) => [targetId(target), { checkedAt, downReason }] as const),
    );
  }

  /**
   * Whether a target is offered calls, or passed over because a call could not reach it or a check found it down.
   *
   * @param target - The target.
   * @returns false while it is passed over.
   */
  isReachable(target: SnapshotTarget): boolean {
    return this.downReason(targetId(target)) === null;
  }

  /**
   * Reads what is known of a target's health, for the pool page.
   *
   * @param target - The target.
   * @returns Whether it is reachable, when it was last checked, and why it is down.
   */
  healthOf(target: SnapshotTarget): TargetHealth {
    const id = targetId(target);
    const downReason = this.downReason(id);
    const checkedAt = this.checks.get(id)?.checkedAt;
    return {
      reachable: downReason === null,
      checkedAt: checkedAt === undefined ? null : new Date(checkedAt),
      downReason,
    };
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
   * Says why a target is passed over, dropping a call failure whose cooldown has ended.
   *
   * @param id - The target's model id.
   * @returns A call failure's reason first, then a failed check's; null when neither holds.
   */
  private downReason(id: string): string | null {
    const failure = this.callFailures.get(id);
    if (failure !== undefined) {
      const isCoolingDown = this.now() < failure.until;
      if (isCoolingDown) {
        return failure.reason;
      }
      this.callFailures.delete(id);
    }
    return this.checks.get(id)?.downReason ?? null;
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
    const weights = candidates.map((candidate) => candidate.weight);
    const over = candidates.map((candidate) => `${targetId(candidate)}\t${candidate.weight}`).join('\n');
    const kept = this.turns.get(pool.id);
    // llm-router kept counting across a change of targets, so the turn pointed somewhere arbitrary.
    const credits = kept?.over === over ? kept.credits : weights.map(() => 0);
    const index = PICK_BY_STRATEGY[pool.strategy]({ loads, weights, credits, random: this.random });
    if (pool.strategy === PoolStrategy.RoundRobin) {
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      const paid = weights.map((weight, at) => (credits[at] ?? 0) + weight - (at === index ? total : 0));
      this.turns.set(pool.id, { over, credits: paid });
    }
    return index;
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
      .map((candidate, index) => ({ index, score: rendezvousScore(key, candidate) }))
      .sort((a, b) => b.score - a.score);
    const factor = pool.maxLoadFactor;
    if (factor === null) {
      return ranked[0]?.index ?? 0;
    }
    // Counting this call, no target may hold more than `factor` times its weighted share. The capacities add up to
    // at least the calls, this one included, so one always has room.
    const total = loads.reduce((sum, load) => sum + load, 0);
    const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
    const capacityOf = (index: number): number =>
      Math.ceil((factor * (total + 1) * (candidates[index]?.weight ?? 0)) / totalWeight);
    const withRoom = ranked.find(({ index }) => (loads[index] ?? 0) < capacityOf(index));
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
