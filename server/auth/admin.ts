import { and, eq, sql } from 'drizzle-orm';
import { conflict, notFound } from '../core/errors.ts';
import type { DB, Transaction } from '../db/client.ts';
import { Role, users } from '../db/tables/users.ts';

/** What changing the last admin is told. */
const LAST_ADMIN = 'The router needs at least one admin. Make someone else an admin first.';

/**
 * Whether a user is an admin.
 *
 * @param db - The database.
 * @param userId - The user.
 * @returns Their role is admin; false for a user that does not exist.
 */
export async function isAdmin(db: DB, userId: string): Promise<boolean> {
  const [user] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId));
  return user?.role === Role.Admin;
}

/**
 * Makes a new account an admin when the router has none.
 *
 * @param db - The database.
 * @param userId - The account just created.
 *
 * @remarks
 * One statement, so two first sign-ins at once cannot both claim it.
 */
export async function claimFirstAdmin(db: DB, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ role: Role.Admin })
    .where(and(eq(users.id, userId), sql`not exists (select 1 from users where role = ${Role.Admin})`));
}

/**
 * Whether anyone has an account yet.
 *
 * @param db - The database.
 * @returns True once the first account exists.
 */
export async function hasUsers(db: DB): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).limit(1);
  return row !== undefined;
}

/**
 * Refuses a change that would leave the router with no admin.
 *
 * @param tx - The transaction the change runs in, which holds a lock on every admin row.
 * @param userId - The user about to stop being an admin, or be deleted.
 * @throws NOT_FOUND when there is no such user, and CONFLICT when they are the last admin.
 */
async function refuseLastAdmin(tx: Transaction, userId: string): Promise<void> {
  const [target] = await tx.select({ role: users.role }).from(users).where(eq(users.id, userId)).for('update');
  if (target === undefined) {
    throw notFound('User not found.');
  }
  if (target.role !== Role.Admin) {
    return;
  }
  // Locked, so two admins demoting each other at once can't both pass.
  const admins = await tx.select({ id: users.id }).from(users).where(eq(users.role, Role.Admin)).for('update');
  if (admins.length <= 1) {
    throw conflict(LAST_ADMIN);
  }
}

/**
 * Gives a user a role.
 *
 * @param db - The database.
 * @param userId - The user.
 * @param role - The new role.
 * @throws NOT_FOUND for no such user, CONFLICT when it would demote the last admin.
 */
export async function setRole(db: DB, userId: string, role: Role): Promise<void> {
  await db.transaction(async (tx) => {
    if (role !== Role.Admin) {
      await refuseLastAdmin(tx, userId);
    }
    const updated = await tx.update(users).set({ role }).where(eq(users.id, userId)).returning({ id: users.id });
    if (updated.length === 0) {
      throw notFound('User not found.');
    }
  });
}

/**
 * Deletes a user, and with them their sessions.
 *
 * @param db - The database.
 * @param userId - The user.
 * @throws NOT_FOUND for no such user, CONFLICT for the last admin.
 */
export async function deleteUser(db: DB, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await refuseLastAdmin(tx, userId);
    await tx.delete(users).where(eq(users.id, userId));
  });
}
