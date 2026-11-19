import { POOL_HEALTH_DEFAULTS, type PoolHealthSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { MS_PER_SECOND } from '../core/wire.ts';
import type { Snapshot, SnapshotHost, SnapshotProvider, SnapshotTarget } from '../db/snapshot.ts';
import type { PoolBalancer, TargetCheck } from './balancer.ts';
import type { ModelCatalog, UpstreamModel } from './catalog.ts';

/** The tag Ollama adds to a model named without one: it serves `qwen3` and lists it as `qwen3:latest`. */
const OLLAMA_DEFAULT_TAG = ':latest';

/** Checks every pool's targets in the background, so the balancer passes over one that is down. */
export interface PoolHealthChecker {
  /**
   * Runs one round: lists each provider that serves an enabled pool once, and hands every target's result to the
   * balancer. A call while a round runs shares it.
   */
  check(): Promise<void>;
  /** Runs a round now, then one every `intervalSeconds`. */
  start(): void;
  /** Stops the timer. A round still running ends on its own, within `timeoutMs`. */
  stop(): void;
}

/** What the checker reads and writes. */
export interface PoolHealthDeps {
  snapshot: SnapshotHost;
  /** Takes each round's results. */
  balancer: PoolBalancer;
  /** Lists the providers' models; each round refreshes its listings. */
  catalog: ModelCatalog;
}

/** One provider to ask in a round, and the targets its answer decides. */
interface ProviderRound {
  provider: SnapshotProvider;
  targets: SnapshotTarget[];
}

/**
 * Gathers the targets a round checks, by provider: those of enabled pools whose provider is enabled.
 *
 * @param snapshot - What the router routes by.
 * @returns One entry per provider, each target once, however many pools have it.
 */
function roundOf(snapshot: Snapshot): ProviderRound[] {
  const byProvider = new Map<string, ProviderRound>();
  const served = [...snapshot.pools.values()].filter((pool) => pool.enabled).flatMap((pool) => pool.targets);
  for (const target of served) {
    const provider = snapshot.providers.get(target.providerName);
    if (provider?.enabled === true) {
      const round = byProvider.get(provider.name) ?? { provider, targets: [] };
      const isKnown = round.targets.some((known) => known.model === target.model);
      if (isKnown === false) {
        round.targets.push(target);
      }
      byProvider.set(provider.name, round);
    }
  }
  return [...byProvider.values()];
}

/**
 * Whether a provider's listing has a target's model, as it would serve it.
 *
 * @param models - The provider's listing.
 * @param model - The target's model id.
 * @returns true when it is listed as named, or with Ollama's default tag.
 */
function isListed(models: readonly UpstreamModel[], model: string): boolean {
  return models.some((listed) => listed.id === model || listed.id === `${model}${OLLAMA_DEFAULT_TAG}`);
}

/**
 * Asks one provider for its models, and reads each of its targets' results from the answer.
 *
 * @param catalog - Lists the provider's models.
 * @param round - The provider and its targets.
 * @param timeoutMs - How long the provider may take.
 * @returns One result per target: all down when the provider can't be listed, else down when its model isn't listed.
 */
async function checkProvider(catalog: ModelCatalog, round: ProviderRound, timeoutMs: number): Promise<TargetCheck[]> {
  const { provider, targets } = round;
  try {
    const models = await catalog.refresh(provider, timeoutMs);
    return targets.map((target) => ({
      target,
      downReason: isListed(models, target.model) ? null : `${provider.name} does not list ${target.model}.`,
    }));
  } catch (error) {
    return targets.map((target) => ({ target, downReason: errorMessage(error) }));
  }
}

/**
 * Builds the checker. Nothing runs until `start` or `check` is called.
 *
 * @param deps - The snapshot, the balancer and the catalog.
 * @param [overrides] - Settings that differ from `POOL_HEALTH_DEFAULTS`.
 * @returns The checker.
 */
export function createPoolHealthChecker(
  { snapshot, balancer, catalog }: PoolHealthDeps,
  overrides: Partial<PoolHealthSettings> = {},
): PoolHealthChecker {
  const { intervalSeconds, timeoutMs } = { ...POOL_HEALTH_DEFAULTS, ...overrides };
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const runRound = async (): Promise<void> => {
    const rounds = roundOf(snapshot.current());
    const results = await Promise.all(rounds.map((round) => checkProvider(catalog, round, timeoutMs)));
    balancer.recordChecks(results.flat());
  };

  const check = (): Promise<void> => {
    if (running === null) {
      running = runRound()
        .catch((error: unknown) =>
          console.error(`[models] A round of pool health checks failed: ${errorMessage(error)}`),
        )
        .finally(() => {
          running = null;
        });
    }
    return running;
  };

  return {
    check,
    start() {
      timer = setInterval(() => void check(), intervalSeconds * MS_PER_SECOND);
      timer.unref();
      void check();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
