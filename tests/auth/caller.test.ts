import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Auth } from '../../server/auth/better-auth.ts';
import { ConflictingKeysError, readCaller, readWorkerCaller, readWorkspaceCaller } from '../../server/auth/caller.ts';
import { findKey, findWorkerKey, hashKey, KEY_PREFIX, mintKey, WORKER_KEY_PREFIX } from '../../server/auth/keys.ts';
import { CALLER_USER, CALLER_WORKER, CALLER_WORKSPACE } from '../../server/core/context.ts';
import { sessions, workers, workspaces } from '../../server/db/schema.ts';
import { loadSnapshot, type Snapshot } from '../../server/db/snapshot.ts';
import { Role } from '../../server/db/tables/users.ts';
import {
  closeTestDb,
  createSessionToken,
  createTestAuth,
  createTestDb,
  createUser,
  createWorkerWithKey,
  createWorkspaceWithKey,
  resetTestDb,
  type TestDb,
} from '../helpers.ts';

const NOW = new Date('2026-11-17T12:00:00Z');
const YESTERDAY = new Date('2026-11-16T12:00:00Z');

let db: TestDb;
let auth: Auth;

/**
 * Reads the caller a set of headers makes, against the database as it is now.
 *
 * @param headers - The request's headers.
 * @returns The caller, or null.
 */
async function callerFor(headers: Record<string, string>) {
  return readCaller({ auth, snapshot: await loadSnapshot(db), now: NOW }, new Headers(headers));
}

beforeAll(async () => {
  db = await createTestDb();
  auth = createTestAuth(db);
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
});

describe('keys', () => {
  it('mints keys with the prefix, keeping only a short start in the clear', () => {
    const { secret, hash, start } = mintKey();
    expect(secret.startsWith(KEY_PREFIX)).toBe(true);
    expect(secret.startsWith(start)).toBe(true);
    expect(start.length).toBeLessThan(secret.length / 2);
    expect(hash).toBe(hashKey(secret));
    expect(mintKey().secret).not.toBe(secret);
  });

  it('finds no key for a secret it has never seen', async () => {
    const snapshot: Snapshot = await loadSnapshot(db);
    expect(findKey(snapshot, mintKey().secret, NOW)).toBeNull();
  });

  it('mints worker keys with their own prefix', () => {
    const { secret, start } = mintKey(WORKER_KEY_PREFIX);
    expect(secret.startsWith(WORKER_KEY_PREFIX)).toBe(true);
    expect(secret.startsWith(start)).toBe(true);
    expect(WORKER_KEY_PREFIX).not.toBe(KEY_PREFIX);
  });

  it('never finds a worker key as a workspace key, even under a workspace key hash', async () => {
    const { secret } = await createWorkerWithKey(db, 'gpu-box');
    const snapshot = await loadSnapshot(db);
    // A snapshot that holds the worker key's hash as a workspace key's too, which no table write can make.
    const keys = new Map(snapshot.keys).set(hashKey(secret), { keyId: 'k', workspaceId: 'w', expiresAt: null });
    const workspacesById = new Map(snapshot.workspaces).set('w', { id: 'w', slug: 'w', name: 'w', workerId: null });
    expect(findKey({ ...snapshot, keys, workspaces: workspacesById }, secret, NOW)).toBeNull();
  });

  it('finds a workspace key as no worker', async () => {
    const { secret } = await createWorkspaceWithKey(db, 'min-agent');
    expect(findWorkerKey(await loadSnapshot(db), secret)).toBeNull();
  });
});

describe('readWorkerCaller', () => {
  /**
   * Reads the worker a set of headers makes, against the database as it is now.
   *
   * @param headers - The request's headers.
   * @returns The worker caller, or null.
   */
  async function workerFor(headers: Record<string, string>) {
    return readWorkerCaller(await loadSnapshot(db), new Headers(headers));
  }

  it('reads a worker from its key, sent either way', async () => {
    const { workerId, secret } = await createWorkerWithKey(db, 'gpu-box');
    const expected = { kind: CALLER_WORKER, workerId, name: 'gpu-box' };
    expect(await workerFor({ authorization: `Bearer ${secret}` })).toEqual(expected);
    expect(await workerFor({ 'x-api-key': secret })).toEqual(expected);
  });

  it('refuses a rotated or deleted key', async () => {
    const { workerId, secret } = await createWorkerWithKey(db, 'gpu-box');
    const rotated = mintKey(WORKER_KEY_PREFIX);
    await db.update(workers).set({ keyHash: rotated.hash, keyPrefix: rotated.start }).where(eq(workers.id, workerId));
    expect(await workerFor({ authorization: `Bearer ${secret}` })).toBeNull();
    await db.delete(workers).where(eq(workers.id, workerId));
    expect(await workerFor({ authorization: `Bearer ${rotated.secret}` })).toBeNull();
  });

  it('refuses a workspace key and a session', async () => {
    const { secret } = await createWorkspaceWithKey(db, 'min-agent');
    const user = await createUser(db, 'ada@example.com', Role.Admin);
    const token = await createSessionToken(auth, user.userId);
    expect(await workerFor({ authorization: `Bearer ${secret}` })).toBeNull();
    expect(await workerFor({ authorization: `Bearer ${token}` })).toBeNull();
  });
});

describe('readCaller', () => {
  it('reads a workspace from a key sent as a bearer', async () => {
    const { workspaceId, keyId, secret } = await createWorkspaceWithKey(db, 'min-agent');
    expect(await callerFor({ authorization: `Bearer ${secret}` })).toEqual({
      kind: CALLER_WORKSPACE,
      workspaceId,
      keyId,
    });
  });

  it('reads a workspace from a key sent as x-api-key', async () => {
    const { workspaceId, secret } = await createWorkspaceWithKey(db, 'min-agent');
    expect(await callerFor({ 'x-api-key': secret })).toMatchObject({ kind: CALLER_WORKSPACE, workspaceId });
  });

  it('accepts the same key sent both ways', async () => {
    const { workspaceId, secret } = await createWorkspaceWithKey(db, 'min-agent');
    const caller = await callerFor({ authorization: `Bearer ${secret}`, 'x-api-key': secret });
    expect(caller).toMatchObject({ kind: CALLER_WORKSPACE, workspaceId });
  });

  it('refuses two different keys', async () => {
    const first = await createWorkspaceWithKey(db, 'min-agent');
    const second = await createWorkspaceWithKey(db, 'task-server');
    const headers = { authorization: `Bearer ${first.secret}`, 'x-api-key': second.secret };
    await expect(callerFor(headers)).rejects.toThrow(ConflictingKeysError);
  });

  it('reads a person from a session token', async () => {
    const user = await createUser(db, 'ada@example.com', Role.Admin);
    const token = await createSessionToken(auth, user.userId);
    expect(await callerFor({ authorization: `Bearer ${token}` })).toEqual({
      kind: CALLER_USER,
      userId: user.userId,
      role: Role.Admin,
    });
  });

  it('never reads a session from x-api-key', async () => {
    const user = await createUser(db, 'ada@example.com');
    const token = await createSessionToken(auth, user.userId);
    expect(await callerFor({ 'x-api-key': token })).toBeNull();
  });

  it('does not fall through to the session when x-api-key is a dead key', async () => {
    const user = await createUser(db, 'ada@example.com');
    const token = await createSessionToken(auth, user.userId);
    expect(await callerFor({ authorization: `Bearer ${token}`, 'x-api-key': token })).toBeNull();
  });

  it('refuses a key that has expired', async () => {
    const { secret } = await createWorkspaceWithKey(db, 'min-agent', YESTERDAY);
    expect(await callerFor({ authorization: `Bearer ${secret}` })).toBeNull();
  });

  it('refuses a key whose workspace is gone, which deletes the key', async () => {
    const { workspaceId, secret } = await createWorkspaceWithKey(db, 'min-agent');
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    expect(await callerFor({ 'x-api-key': secret })).toBeNull();
  });

  it('refuses a session that has run out', async () => {
    const user = await createUser(db, 'ada@example.com');
    const token = await createSessionToken(auth, user.userId);
    await db.update(sessions).set({ expiresAt: YESTERDAY }).where(eq(sessions.token, token));
    expect(await callerFor({ authorization: `Bearer ${token}` })).toBeNull();
  });

  it('reads nobody from a worker key, sent either way', async () => {
    const { secret } = await createWorkerWithKey(db, 'gpu-box');
    const sent: Record<string, string>[] = [{ authorization: `Bearer ${secret}` }, { 'x-api-key': secret }];
    for (const headers of sent) {
      expect(await callerFor(headers)).toBeNull();
      expect(readWorkspaceCaller(await loadSnapshot(db), new Headers(headers), NOW)).toBeNull();
    }
  });

  it.each<Record<string, string>>([
    {},
    { authorization: 'Bearer ' },
    { authorization: 'Basic abc' },
    { 'x-api-key': '' },
  ])('reads nobody from %j', async (headers) => {
    expect(await callerFor(headers)).toBeNull();
  });
});
