import { asc } from 'drizzle-orm';
import type { DB } from './client.ts';
import { poolTargets } from './tables/pool-targets.ts';
import { type PoolAffinity, type PoolStrategy, pools } from './tables/pools.ts';
import { providers } from './tables/providers.ts';
import { workspaceKeys } from './tables/workspace-keys.ts';
import { workspaces } from './tables/workspaces.ts';

/** A workspace as the gateways see it. */
export interface SnapshotWorkspace {
  id: string;
  slug: string;
  name: string;
}

/** A workspace key as the gateways see it, found by its hash. */
export interface SnapshotKey {
  keyId: string;
  workspaceId: string;
  /** null for a key that never expires. */
  expiresAt: Date | null;
}

/** A provider as a run's model calls see it. */
export interface SnapshotProvider {
  id: string;
  name: string;
  enabled: boolean;
  baseUrl: string;
  /** null when none is set. */
  apiKey: string | null;
  headers: Readonly<Record<string, string>>;
  /** When it last changed, so a model list fetched before then is stale. */
  updatedAt: Date;
}

/** One place a pool can send a call. */
export interface SnapshotTarget {
  providerId: string;
  /** The provider's name, as `providers` is keyed. */
  providerName: string;
  /** The model's id at the provider. */
  model: string;
}

/** A pool as a run's model calls see it. */
export interface SnapshotPool {
  id: string;
  name: string;
  enabled: boolean;
  strategy: PoolStrategy;
  affinity: PoolAffinity;
  /** null for bounded load off. */
  maxLoadFactor: number | null;
  /** In the pool's order. */
  targets: readonly SnapshotTarget[];
}

/** Everything requests route by, read once and held in memory. */
export interface Snapshot {
  /** By id. */
  workspaces: ReadonlyMap<string, SnapshotWorkspace>;
  /** By the key's SHA-256, in hex. */
  keys: ReadonlyMap<string, SnapshotKey>;
  /** By name, as a model id names them. */
  providers: ReadonlyMap<string, SnapshotProvider>;
  /** By name, as a model id names them. */
  pools: ReadonlyMap<string, SnapshotPool>;
}

/** A snapshot with nothing in it. */
export const EMPTY_SNAPSHOT: Snapshot = Object.freeze({
  workspaces: new Map(),
  keys: new Map(),
  providers: new Map(),
  pools: new Map(),
});

/** Holds the current snapshot, and builds a new one after a write. */
export interface SnapshotHost {
  /** The snapshot to route this request by. */
  current: () => Snapshot;
  /**
   * Reads everything again. Call it after the write's transaction commits.
   *
   * @remarks
   * Calls that arrive while a read is waiting to start share it. A call during a read queues one more,
   * so every committed write is seen. A failed read keeps the old snapshot and rejects.
   */
  rebuild: () => Promise<void>;
}

/**
 * Reads the snapshot from the database.
 *
 * @param db - The router's database.
 * @returns A new snapshot.
 */
export async function loadSnapshot(db: DB): Promise<Snapshot> {
  const [workspaceRows, keyRows, providerRows, poolRows, targetRows] = await Promise.all([
    db.select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name }).from(workspaces),
    db
      .select({
        keyId: workspaceKeys.id,
        workspaceId: workspaceKeys.workspaceId,
        hash: workspaceKeys.hash,
        expiresAt: workspaceKeys.expiresAt,
      })
      .from(workspaceKeys),
    db
      .select({
        id: providers.id,
        name: providers.name,
        enabled: providers.enabled,
        baseUrl: providers.baseUrl,
        apiKey: providers.apiKey,
        headers: providers.headers,
        updatedAt: providers.updatedAt,
      })
      .from(providers),
    db.select().from(pools),
    db.select().from(poolTargets).orderBy(asc(poolTargets.position)),
  ]);
  const providerNames = new Map(providerRows.map((row) => [row.id, row.name]));
  const targetsByPool = new Map<string, SnapshotTarget[]>();
  for (const { poolId, providerId, model } of targetRows) {
    const providerName = providerNames.get(providerId) ?? '';
    targetsByPool.set(poolId, [...(targetsByPool.get(poolId) ?? []), { providerId, providerName, model }]);
  }
  return {
    workspaces: new Map(workspaceRows.map((row) => [row.id, row])),
    keys: new Map(keyRows.map(({ hash, ...key }) => [hash, key])),
    providers: new Map(providerRows.map((row) => [row.name, row])),
    pools: new Map(
      poolRows.map((row) => [
        row.name,
        {
          id: row.id,
          name: row.name,
          enabled: row.enabled,
          strategy: row.strategy,
          affinity: row.affinity,
          maxLoadFactor: row.maxLoadFactor,
          targets: targetsByPool.get(row.id) ?? [],
        },
      ]),
    ),
  };
}

/**
 * Builds the snapshot host, with its first snapshot read.
 *
 * @param db - The router's database. Migrations must have run.
 * @param [load] - How a snapshot is read. Tests pass their own.
 * @returns The host.
 */
export async function createSnapshotHost(
  db: DB,
  load: (db: DB) => Promise<Snapshot> = loadSnapshot,
): Promise<SnapshotHost> {
  let snapshot = await load(db);
  let latest: Promise<void> = Promise.resolve();
  let waiting: Promise<void> | null = null;
  return {
    current: () => snapshot,
    rebuild: () => {
      if (waiting !== null) {
        return waiting;
      }
      const next = latest
        .catch(() => {})
        .then(async () => {
          // From here on, a new write needs a read of its own.
          waiting = null;
          snapshot = await load(db);
        });
      waiting = next;
      latest = next;
      return next;
    },
  };
}
