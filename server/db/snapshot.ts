import type { DB } from './client.ts';
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

/** Everything the gateways route by, read once and held in memory. */
export interface Snapshot {
  /** By id. */
  workspaces: ReadonlyMap<string, SnapshotWorkspace>;
  /** By the key's SHA-256, in hex. */
  keys: ReadonlyMap<string, SnapshotKey>;
}

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
  const [workspaceRows, keyRows] = await Promise.all([
    db.select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name }).from(workspaces),
    db
      .select({
        keyId: workspaceKeys.id,
        workspaceId: workspaceKeys.workspaceId,
        hash: workspaceKeys.hash,
        expiresAt: workspaceKeys.expiresAt,
      })
      .from(workspaceKeys),
  ]);
  return {
    workspaces: new Map(workspaceRows.map((row) => [row.id, row])),
    keys: new Map(keyRows.map(({ hash, ...key }) => [hash, key])),
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
