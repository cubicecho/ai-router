import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readCaller } from '../../server/auth/caller.ts';
import { CALLER_WORKSPACE, type UserCaller } from '../../server/core/context.ts';
import { NAME_DEFAULTS, OPERATION_LIMIT_DEFAULTS, WORKSPACE_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import {
  closeTestDb,
  createClient,
  createTestAuth,
  createTestDb,
  createUser,
  createWorkspaceWithKey,
  resetTestDb,
  type TestClient,
  type TestDb,
  workspaceCaller,
} from '../helpers.ts';

const CREATE = `mutation ($slug: String!, $name: String!) {
  createWorkspace(values: { slug: $slug, name: $name }) { id slug name description }
}`;
const RENAME =
  'mutation ($id: UUID!, $slug: String!) { updateWorkspace(where: { id: { eq: $id } }, set: { slug: $slug }) { slug } }';
const DELETE = 'mutation ($id: UUID!) { deleteWorkspace(where: { id: { eq: $id } }) { id } }';
const CREATE_KEY = `mutation ($workspaceId: UUID!, $name: String!, $expiresInDays: Int) {
  createWorkspaceKey(workspaceId: $workspaceId, name: $name, expiresInDays: $expiresInDays) {
    secret
    key { id name start expiresAt workspace { slug } }
  }
}`;
const REVOKE_KEY = 'mutation ($id: UUID!) { revokeWorkspaceKey(id: $id) }';
const KEYS = '{ workspaceKeys { id name start } }';

let db: TestDb;
let user: UserCaller;
let client: TestClient;

/**
 * Reads the caller a key makes, against the client's snapshot.
 *
 * @param secret - The key.
 * @returns The caller, or null.
 */
function callerFrom(secret: string) {
  const headers = new Headers({ authorization: `Bearer ${secret}` });
  return readCaller({ auth: createTestAuth(db), snapshot: client.snapshot.current(), now: new Date() }, headers);
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
  user = await createUser(db, 'ada@example.com');
  client = await createClient(db, user);
});

describe('workspaces', () => {
  it('creates a workspace any user may make', async () => {
    const { createWorkspace } = await client.expectOk(CREATE, { slug: 'min-agent', name: 'min-agent' });
    expect(createWorkspace).toMatchObject({ slug: 'min-agent', name: 'min-agent', description: '' });
  });

  it.each(['Min-Agent', '-first', '.hidden', 'has space', 'a/b', ''])('refuses the slug %j', async (slug) => {
    const { code } = await client.expectError(CREATE, { slug, name: 'x' });
    expect(code).toBe(ErrorCode.BadUserInput);
  });

  it('refuses a slug longer than the limit', async () => {
    const slug = `a${'b'.repeat(NAME_DEFAULTS.maxLength)}`;
    expect((await client.expectError(CREATE, { slug, name: 'x' })).code).toBe(ErrorCode.BadUserInput);
  });

  it('says a slug is taken, rather than masking the unique index', async () => {
    await client.expectOk(CREATE, { slug: 'min-agent', name: 'one' });
    const { code, message } = await client.expectError(CREATE, { slug: 'min-agent', name: 'two' });
    expect(code).toBe(ErrorCode.BadUserInput);
    expect(message).toContain('already exists');
  });

  it.each(['llama.cpp', 'gpu_box', '1st-floor'])('accepts the slug %j, as the old routers did', async (slug) => {
    const { createWorkspace } = await client.expectOk(CREATE, { slug, name: 'x' });
    expect(createWorkspace.slug).toBe(slug);
  });

  it('validates an update too', async () => {
    const { createWorkspace } = await client.expectOk(CREATE, { slug: 'min-agent', name: 'x' });
    const { code } = await client.expectError(RENAME, { id: createWorkspace.id, slug: 'Bad Slug' });
    expect(code).toBe(ErrorCode.BadUserInput);
  });

  it('refuses a workspace key on the admin API', async () => {
    const { workspaceId, keyId } = await createWorkspaceWithKey(db, 'min-agent');
    const app = await createClient(db, workspaceCaller(workspaceId, keyId));
    expect((await app.expectError('{ workspaces { id } }')).code).toBe(ErrorCode.Forbidden);
    expect((await app.expectError(CREATE, { slug: 'mine', name: 'x' })).code).toBe(ErrorCode.Forbidden);
  });

  it('refuses nobody with UNAUTHENTICATED', async () => {
    const nobody = await createClient(db, null);
    expect((await nobody.expectError('{ workspaces { id } }')).code).toBe(ErrorCode.Unauthenticated);
  });

  it('refuses a page larger than the limit', async () => {
    const { code } = await client.expectError(
      `{ workspaces(limit: ${OPERATION_LIMIT_DEFAULTS.maxPageSize + 1}) { id } }`,
    );
    expect(code).toBe('DRIZZLE_LIMIT_EXCEEDED');
  });
});

describe('workspace keys', () => {
  let workspaceId: string;

  beforeEach(async () => {
    const { createWorkspace } = await client.expectOk(CREATE, { slug: 'min-agent', name: 'min-agent' });
    workspaceId = createWorkspace.id;
  });

  it('makes a key that works at once, and shows the secret only in that answer', async () => {
    const { createWorkspaceKey } = await client.expectOk(CREATE_KEY, { workspaceId, name: 'phone' });
    expect(createWorkspaceKey.key).toMatchObject({ name: 'phone', expiresAt: null, workspace: { slug: 'min-agent' } });
    expect(createWorkspaceKey.secret.startsWith(createWorkspaceKey.key.start)).toBe(true);
    expect(await callerFrom(createWorkspaceKey.secret)).toMatchObject({ kind: CALLER_WORKSPACE, workspaceId });
    const listed = JSON.stringify(await client.expectOk(KEYS));
    expect(listed).not.toContain(createWorkspaceKey.secret);
  });

  it('never serves the hash', async () => {
    const { message } = await client.expectError('{ workspaceKeys { hash } }');
    expect(message).toContain('Cannot query field "hash"');
  });

  it('gives a key an expiry when asked', async () => {
    const { createWorkspaceKey } = await client.expectOk(CREATE_KEY, { workspaceId, name: 'ci', expiresInDays: 30 });
    expect(createWorkspaceKey.key.expiresAt).not.toBeNull();
  });

  it.each([0, -1, WORKSPACE_DEFAULTS.maxKeyExpiryDays + 1])('refuses an expiry of %j days', async (expiresInDays) => {
    const { code } = await client.expectError(CREATE_KEY, { workspaceId, name: 'ci', expiresInDays });
    expect(code).toBe(ErrorCode.BadUserInput);
  });

  it('refuses a key with no name', async () => {
    expect((await client.expectError(CREATE_KEY, { workspaceId, name: '  ' })).code).toBe(ErrorCode.BadUserInput);
  });

  it('answers NOT_FOUND for a workspace that does not exist', async () => {
    const { code } = await client.expectError(CREATE_KEY, {
      workspaceId: '00000000-0000-4000-8000-000000000000',
      name: 'phone',
    });
    expect(code).toBe(ErrorCode.NotFound);
  });

  it('revokes a key so it stops working at once', async () => {
    const { createWorkspaceKey } = await client.expectOk(CREATE_KEY, { workspaceId, name: 'phone' });
    expect(await client.expectOk(REVOKE_KEY, { id: createWorkspaceKey.key.id })).toEqual({ revokeWorkspaceKey: true });
    expect(await callerFrom(createWorkspaceKey.secret)).toBeNull();
    expect(await client.expectOk(REVOKE_KEY, { id: createWorkspaceKey.key.id })).toEqual({ revokeWorkspaceKey: false });
  });

  it("deletes a workspace's keys with it, and the snapshot forgets them", async () => {
    const { createWorkspaceKey } = await client.expectOk(CREATE_KEY, { workspaceId, name: 'phone' });
    await client.expectOk(DELETE, { id: workspaceId });
    await client.snapshot.rebuild();
    expect(await callerFrom(createWorkspaceKey.secret)).toBeNull();
  });

  it('refuses a key that tries to make or revoke keys', async () => {
    const app = await createClient(db, workspaceCaller(workspaceId, '00000000-0000-4000-8000-000000000000'));
    expect((await app.expectError(CREATE_KEY, { workspaceId, name: 'next' })).code).toBe(ErrorCode.Forbidden);
  });
});
