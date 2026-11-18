import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimFirstAdmin } from '../../server/auth/admin.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { users } from '../../server/db/schema.ts';
import { Role } from '../../server/db/tables/users.ts';
import { closeTestDb, createClient, createTestDb, createUser, resetTestDb, type TestDb } from '../helpers.ts';

const SET_ROLE = 'mutation ($id: UUID!, $role: UsersRoleEnum!) { setUserRole(id: $id, role: $role) { id role } }';
const DELETE_USER = 'mutation ($id: UUID!) { deleteUser(id: $id) }';
const ME = '{ me { id email role } }';

let db: TestDb;

/**
 * Reads a user's role.
 *
 * @param id - The user.
 * @returns Their role, or undefined when they are gone.
 */
async function roleOf(id: string) {
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, id));
  return user?.role;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
});

describe('the first admin', () => {
  it('makes the first user to sign in an admin, and nobody after', async () => {
    const first = await createUser(db, 'first@example.com');
    const second = await createUser(db, 'second@example.com');
    await claimFirstAdmin(db, first.userId);
    await claimFirstAdmin(db, second.userId);
    expect(await roleOf(first.userId)).toBe(Role.Admin);
    expect(await roleOf(second.userId)).toBe(Role.User);
  });
});

describe('roles', () => {
  it('answers me with the caller and their role', async () => {
    const ada = await createUser(db, 'ada@example.com', Role.Admin);
    const { me } = await (await createClient(db, ada)).expectOk(ME);
    expect(me).toEqual({ id: ada.userId, email: 'ada@example.com', role: Role.Admin });
  });

  it('lets an admin make a user an admin', async () => {
    const admin = await createUser(db, 'admin@example.com', Role.Admin);
    const bob = await createUser(db, 'bob@example.com');
    await (await createClient(db, admin)).expectOk(SET_ROLE, { id: bob.userId, role: Role.Admin });
    expect(await roleOf(bob.userId)).toBe(Role.Admin);
  });

  it('refuses a user who is not an admin', async () => {
    await createUser(db, 'admin@example.com', Role.Admin);
    const bob = await createUser(db, 'bob@example.com');
    const client = await createClient(db, bob);
    expect((await client.expectError(SET_ROLE, { id: bob.userId, role: Role.Admin })).code).toBe(ErrorCode.Forbidden);
    expect((await client.expectError(DELETE_USER, { id: bob.userId })).code).toBe(ErrorCode.Forbidden);
  });

  it('refuses to demote the last admin', async () => {
    const admin = await createUser(db, 'admin@example.com', Role.Admin);
    const { code } = await (await createClient(db, admin)).expectError(SET_ROLE, { id: admin.userId, role: Role.User });
    expect(code).toBe(ErrorCode.Conflict);
    expect(await roleOf(admin.userId)).toBe(Role.Admin);
  });

  it('refuses to delete the last admin', async () => {
    const admin = await createUser(db, 'admin@example.com', Role.Admin);
    const { code } = await (await createClient(db, admin)).expectError(DELETE_USER, { id: admin.userId });
    expect(code).toBe(ErrorCode.Conflict);
  });

  it('lets one of two admins step down', async () => {
    const admin = await createUser(db, 'admin@example.com', Role.Admin);
    await createUser(db, 'other@example.com', Role.Admin);
    await (await createClient(db, admin)).expectOk(SET_ROLE, { id: admin.userId, role: Role.User });
    expect(await roleOf(admin.userId)).toBe(Role.User);
  });

  it('deletes a user who is not the last admin', async () => {
    const admin = await createUser(db, 'admin@example.com', Role.Admin);
    const bob = await createUser(db, 'bob@example.com');
    expect(await (await createClient(db, admin)).expectOk(DELETE_USER, { id: bob.userId })).toEqual({
      deleteUser: true,
    });
    expect(await roleOf(bob.userId)).toBeUndefined();
  });

  it('answers NOT_FOUND for a user who does not exist', async () => {
    const admin = await createUser(db, 'admin@example.com', Role.Admin);
    const { code } = await (await createClient(db, admin)).expectError(SET_ROLE, {
      id: '00000000-0000-4000-8000-000000000000',
      role: Role.User,
    });
    expect(code).toBe(ErrorCode.NotFound);
  });
});
