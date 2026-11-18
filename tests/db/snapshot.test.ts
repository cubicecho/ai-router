import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashKey } from '../../server/auth/keys.ts';
import { workspaces } from '../../server/db/schema.ts';
import { createSnapshotHost, EMPTY_SNAPSHOT, loadSnapshot, type Snapshot } from '../../server/db/snapshot.ts';
import { closeTestDb, createTestDb, createWorkspaceWithKey, resetTestDb, type TestDb } from '../helpers.ts';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
});

describe('the snapshot', () => {
  it('holds workspaces by id and keys by hash', async () => {
    const { workspaceId, keyId, secret } = await createWorkspaceWithKey(db, 'min-agent');
    const snapshot = await loadSnapshot(db);
    expect(snapshot.workspaces.get(workspaceId)).toEqual({ id: workspaceId, slug: 'min-agent', name: 'min-agent' });
    expect(snapshot.keys.get(hashKey(secret))).toEqual({ keyId, workspaceId, expiresAt: null });
  });

  it('sees a write only once rebuilt', async () => {
    const host = await createSnapshotHost(db);
    await db.insert(workspaces).values({ slug: 'later', name: 'later' });
    expect(host.current().workspaces.size).toBe(0);
    await host.rebuild();
    expect(host.current().workspaces.size).toBe(1);
  });

  it('shares one read between calls waiting for it, and queues one more behind a read in progress', async () => {
    let reads = 0;
    let release: () => void = () => {};
    const empty: Snapshot = EMPTY_SNAPSHOT;
    const host = await createSnapshotHost(db, async () => {
      reads += 1;
      if (reads === 2) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return empty;
    });
    const first = host.rebuild();
    const shared = host.rebuild();
    expect(shared).toBe(first);
    // Let the first read start, then ask again while it waits.
    await new Promise((resolve) => setImmediate(resolve));
    const behind = host.rebuild();
    release();
    await Promise.all([first, behind]);
    expect(reads).toBe(3);
  });

  it('keeps the old snapshot when a read fails', async () => {
    let shouldFail = false;
    const kept: Snapshot = { ...EMPTY_SNAPSHOT };
    const host = await createSnapshotHost(db, async () => {
      if (shouldFail) {
        throw new Error('database down');
      }
      return kept;
    });
    shouldFail = true;
    await expect(host.rebuild()).rejects.toThrow('database down');
    expect(host.current()).toBe(kept);
    shouldFail = false;
    await expect(host.rebuild()).resolves.toBeUndefined();
  });
});
