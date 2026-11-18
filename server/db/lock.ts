import type pg from 'pg';
import { errorMessage } from '../core/errors.ts';

/** What `pg_try_advisory_lock` is asked for: one lock per database, the same in every router. */
const ADVISORY_LOCK_NAME = 'ai-router';
/** A database this process owns until it lets go. */
export interface Claim {
  /** Gives the database up. Safe to call twice. */
  release: () => Promise<void>;
}

/**
 * Claims a Postgres database with a session advisory lock, or refuses.
 *
 * @param pool - The router's pool. One connection is kept out of it, holding the lock, until release.
 * @returns The claim, which unlocks and returns the connection.
 * @throws When another router holds the lock.
 */
export async function claimAdvisoryLock(pool: pg.Pool): Promise<Claim> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtext($1)) as locked', [
      ADVISORY_LOCK_NAME,
    ]);
    const isLocked = result.rows[0]?.locked === true;
    if (isLocked === false) {
      throw new Error(
        'Another ai-router is already using this database. Two routers on one database would route from different snapshots, so this one is stopping.',
      );
    }
  } catch (error) {
    client.release();
    throw error;
  }
  let isHeld = true;
  return {
    release: async () => {
      if (isHeld === false) {
        return;
      }
      isHeld = false;
      try {
        await client.query('select pg_advisory_unlock(hashtext($1))', [ADVISORY_LOCK_NAME]);
      } catch (error) {
        // Closing the connection drops the lock anyway.
        console.warn(`[db] could not release the advisory lock: ${errorMessage(error)}`);
      }
      client.release();
    },
  };
}
