import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readWorkerCaller } from '../../server/auth/caller.ts';
import { hashKey, WORKER_KEY_PREFIX } from '../../server/auth/keys.ts';
import { ADMIN_ROLES } from '../../server/core/admin-roles.ts';
import { CALLER_RUN, CALLER_WORKER, type UserCaller } from '../../server/core/context.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { runs } from '../../server/db/tables/runs.ts';
import { LOCAL_WORKER_NAME, workers } from '../../server/db/tables/workers.ts';
import {
  closeTestDb,
  createClient,
  createTestDb,
  createUser,
  createWorkspaceWithKey,
  resetTestDb,
  type TestClient,
  type TestDb,
  workspaceCaller,
} from '../helpers.ts';

const CREATE = `mutation ($name: String!) {
  createWorker(name: $name) { secret worker { id name keyPrefix keySet createdAt lastSeenAt host version } }
}`;
const ROTATE = 'mutation ($id: UUID!) { rotateWorkerKey(id: $id) { secret worker { id keyPrefix } } }';
const DELETE = 'mutation ($id: UUID!) { deleteWorker(id: $id) }';
const SET_WORKER = `mutation ($workspaceId: UUID!, $workerId: UUID) {
  setWorkspaceWorker(workspaceId: $workspaceId, workerId: $workerId) { id workerId worker { name } }
}`;
const COPY = `mutation ($fromWorkspaceId: UUID!) {
  copyWorkspace(fromWorkspaceId: $fromWorkspaceId, slug: "copy", name: "Copy") { workerId }
}`;
const UPDATE_WORKSPACE = `mutation ($id: UUID!, $workerId: UUID) {
  updateWorkspace(where: { id: { eq: $id } }, set: { workerId: $workerId }) { id }
}`;
/** Everything a person can read about workers, to scan for a key. */
const EVERYTHING = `{
  workers { id name keyPrefix keySet createdAt lastSeenAt host version creator { email } workspaces { slug } runs { id } }
  workspaces { slug workerId worker { name keyPrefix keySet } }
  runs { id worker { name keyPrefix } }
}`;

let db: TestDb;
let user: UserCaller;
let client: TestClient;
let localId: string;
let workspaceId: string;

/**
 * Makes a worker through the API, as a person would.
 *
 * @param name - Its name.
 * @returns Its id and its key.
 */
async function addWorker(name = 'gpu-box'): Promise<{ id: string; secret: string }> {
  const { createWorker } = await client.expectOk(CREATE, { name });
  return { id: createWorker.worker.id, secret: createWorker.secret };
}

/**
 * Reads the worker a key makes, against the client's snapshot.
 *
 * @param secret - The key.
 * @returns The worker caller, or null.
 */
function workerFrom(secret: string) {
  return readWorkerCaller(client.snapshot.current(), new Headers({ authorization: `Bearer ${secret}` }));
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
  user = await createUser(db, 'ada@example.com');
  client = createClient(db, user);
  const [local] = await db.select({ id: workers.id }).from(workers).where(eq(workers.name, LOCAL_WORKER_NAME));
  localId = local?.id ?? '';
  ({ workspaceId } = await createWorkspaceWithKey(db, 'min-agent'));
});

describe('the local worker', () => {
  it('is on every router, with no key', async () => {
    const { workers: listed } = await client.expectOk('{ workers { id name keyPrefix keySet } }');
    expect(listed).toEqual([{ id: localId, name: LOCAL_WORKER_NAME, keyPrefix: null, keySet: false }]);
  });

  it('is taken by no other worker, and given no key', async () => {
    const { code } = await client.expectError(CREATE, { name: LOCAL_WORKER_NAME });
    expect(code).toBe(ErrorCode.BadUserInput);
    expect((await client.expectError(ROTATE, { id: localId })).code).toBe(ErrorCode.BadUserInput);
    const keyed = db.update(workers).set({ keyHash: 'x', keyPrefix: 'x' }).where(eq(workers.id, localId));
    await expect(keyed).rejects.toThrow();
    await expect(db.insert(workers).values({ name: 'keyless' })).rejects.toThrow();
  });

  it('cannot be deleted or renamed', async () => {
    expect((await client.expectError(DELETE, { id: localId })).code).toBe(ErrorCode.BadUserInput);
    const rename = 'mutation ($id: UUID!) { updateWorker(where: { id: { eq: $id } }, set: { name: "x" }) { id } }';
    expect((await client.expectError(rename, { id: localId })).message).toContain('Cannot query field');
    await expect(db.update(workers).set({ name: 'renamed' }).where(eq(workers.id, localId))).rejects.toThrow();
  });
});

describe('createWorker', () => {
  it('makes a worker whose key works at once, shown only in that answer', async () => {
    const { createWorker } = await client.expectOk(CREATE, { name: 'gpu-box' });
    const { secret, worker } = createWorker;
    expect(secret.startsWith(WORKER_KEY_PREFIX)).toBe(true);
    expect(secret.startsWith(worker.keyPrefix)).toBe(true);
    expect(worker).toMatchObject({ name: 'gpu-box', keySet: true, lastSeenAt: null, host: null, version: null });
    expect(workerFrom(secret)).toEqual({ kind: CALLER_WORKER, workerId: worker.id, name: 'gpu-box' });
    const [row] = await db.select().from(workers).where(eq(workers.id, worker.id));
    expect(row).toMatchObject({ keyHash: hashKey(secret), createdBy: user.userId });
  });

  it.each(['Bad Name', '', '-x'])('refuses the name %j', async (name) => {
    expect((await client.expectError(CREATE, { name })).code).toBe(ErrorCode.BadUserInput);
  });

  it('says a name is taken', async () => {
    await addWorker('gpu-box');
    const { code, message } = await client.expectError(CREATE, { name: 'gpu-box' });
    expect(code).toBe(ErrorCode.BadUserInput);
    expect(message).toContain('already exists');
  });

  it('never serves the key or its hash', async () => {
    const { id, secret } = await addWorker();
    await db.insert(runs).values({ workspaceName: 'min-agent', agentName: 'a', stream: false, workerId: id });
    await client.expectOk(SET_WORKER, { workspaceId, workerId: id });
    const answer = JSON.stringify(await client.expectOk(EVERYTHING));
    expect(answer).not.toContain(secret);
    expect(answer).not.toContain(hashKey(secret));
    expect((await client.expectError('{ workers { keyHash } }')).message).toContain('Cannot query field "keyHash"');
  });
});

describe('rotateWorkerKey', () => {
  it('gives a new key and refuses the old one from then on', async () => {
    const { id, secret } = await addWorker();
    const { rotateWorkerKey } = await client.expectOk(ROTATE, { id });
    expect(rotateWorkerKey.secret).not.toBe(secret);
    expect(workerFrom(secret)).toBeNull();
    expect(workerFrom(rotateWorkerKey.secret)).toMatchObject({ workerId: id });
  });

  it('answers NOT_FOUND for a worker that does not exist', async () => {
    const { code } = await client.expectError(ROTATE, { id: crypto.randomUUID() });
    expect(code).toBe(ErrorCode.NotFound);
  });
});

describe('deleteWorker', () => {
  it('removes a worker and its key, leaving its runs naming none', async () => {
    const { id, secret } = await addWorker();
    const [run] = await db
      .insert(runs)
      .values({ workspaceName: 'min-agent', agentName: 'a', stream: false, workerId: id })
      .returning();
    expect(await client.expectOk(DELETE, { id })).toEqual({ deleteWorker: true });
    expect(workerFrom(secret)).toBeNull();
    const [kept] = await db
      .select({ workerId: runs.workerId })
      .from(runs)
      .where(eq(runs.id, run?.id ?? ''));
    expect(kept).toEqual({ workerId: null });
    expect(await client.expectOk(DELETE, { id })).toEqual({ deleteWorker: false });
  });

  it('is refused while a workspace runs on it', async () => {
    const { id } = await addWorker();
    await client.expectOk(SET_WORKER, { workspaceId, workerId: id });
    const { code, message } = await client.expectError(DELETE, { id });
    expect(code).toBe(ErrorCode.Conflict);
    expect(message).toContain('min-agent');
  });
});

describe("a workspace's worker", () => {
  it('is local until one is set, and goes into the snapshot', async () => {
    const { id } = await addWorker();
    await client.snapshot.rebuild();
    expect(client.snapshot.current().workspaces.get(workspaceId)?.workerId).toBeNull();
    const { setWorkspaceWorker } = await client.expectOk(SET_WORKER, { workspaceId, workerId: id });
    expect(setWorkspaceWorker).toEqual({ id: workspaceId, workerId: id, worker: { name: 'gpu-box' } });
    expect(client.snapshot.current().workspaces.get(workspaceId)?.workerId).toBe(id);
  });

  it('is stored as none for local, named or left out', async () => {
    const { id } = await addWorker();
    for (const workerId of [localId, null]) {
      await client.expectOk(SET_WORKER, { workspaceId, workerId: id });
      const { setWorkspaceWorker } = await client.expectOk(SET_WORKER, { workspaceId, workerId });
      expect(setWorkspaceWorker).toMatchObject({ workerId: null, worker: null });
    }
  });

  it('answers NOT_FOUND for an unknown worker or workspace', async () => {
    const unknownWorker = await client.expectError(SET_WORKER, { workspaceId, workerId: crypto.randomUUID() });
    expect(unknownWorker.code).toBe(ErrorCode.NotFound);
    const unknownWorkspace = await client.expectError(SET_WORKER, { workspaceId: crypto.randomUUID() });
    expect(unknownWorkspace.code).toBe(ErrorCode.NotFound);
  });

  it('is set only by setWorkspaceWorker, never by a generated write', async () => {
    const { id } = await addWorker();
    const { code } = await client.expectError(UPDATE_WORKSPACE, { id: workspaceId, workerId: id });
    expect(code).toBe(ErrorCode.BadUserInput);
  });

  it('is copied with the workspace', async () => {
    const { id } = await addWorker();
    await client.expectOk(SET_WORKER, { workspaceId, workerId: id });
    const { copyWorkspace } = await client.expectOk(COPY, { fromWorkspaceId: workspaceId });
    expect(copyWorkspace).toEqual({ workerId: id });
  });
});

describe('who reaches workers', () => {
  it('is people only: a workspace key and an agent run with every role are refused', async () => {
    const { id } = await addWorker();
    const app = createClient(db, workspaceCaller(workspaceId, crypto.randomUUID()));
    const run = createClient(db, {
      kind: CALLER_RUN,
      runId: crypto.randomUUID(),
      workspaceId,
      agentId: crypto.randomUUID(),
      roles: ADMIN_ROLES,
      depth: 0,
    });
    const operations: [string, Record<string, unknown>][] = [
      ['{ workers { id } }', {}],
      ['{ runs { worker { id } } }', {}],
      [CREATE, { name: 'mine' }],
      [ROTATE, { id }],
      [DELETE, { id }],
      [SET_WORKER, { workspaceId, workerId: id }],
    ];
    await db
      .insert(runs)
      .values({ workspaceId, workspaceName: 'min-agent', agentName: 'a', stream: false, workerId: id });
    for (const caller of [app, run]) {
      for (const [query, variables] of operations) {
        expect((await caller.expectError(query, variables)).code, query).toBe(ErrorCode.Forbidden);
      }
    }
  });
});
