import fs from 'node:fs';
import type pg from 'pg';
import { errorMessage } from '../core/errors.ts';

/** What `pg_try_advisory_lock` is asked for: one lock per database, the same in every router. */
const ADVISORY_LOCK_NAME = 'ai-router';
/** The errno for a file that already exists, which `flag: 'wx'` raises. */
const EEXIST = 'EEXIST';
/** The errno for a live process owned by someone else, which still counts as alive. */
const EPERM = 'EPERM';

/** A database this process owns until it lets go. */
export interface Claim {
  /** Gives the database up. Safe to call twice. */
  release: () => Promise<void>;
}

/**
 * Reads the errno code off a caught value.
 *
 * @param error - Whatever was thrown.
 * @returns The code, or undefined when there is none.
 */
function codeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

/**
 * Whether a pid is a process that still exists.
 *
 * @param pid - The process id.
 * @returns true for a live process, including one owned by another user.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === EPERM;
  }
}

/**
 * Claims a PGlite store with a pid file beside it, or refuses.
 *
 * @param store - The PGlite data directory.
 * @returns The claim, which deletes the pid file when released.
 * @throws When another live process holds the store.
 *
 * @remarks
 * PGlite doesn't lock what it opens, and two processes on one directory silently stop seeing each
 * other's writes. A pid that is gone leaves a stale lock, which is taken over.
 */
export function claimDirectory(store: string): Claim {
  const lock = `${store}.lock`;
  // Twice: finding the lock stale and replacing it is two steps, and another process may win between them.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
      let isHeld = true;
      return {
        release: async () => {
          if (isHeld) {
            isHeld = false;
            fs.rmSync(lock, { force: true });
          }
        },
      };
    } catch (error) {
      if (codeOf(error) !== EEXIST) {
        throw error;
      }
      const holder = Number(fs.readFileSync(lock, 'utf8').trim());
      const isHeldElsewhere = holder > 0 && holder !== process.pid && isAlive(holder);
      if (isHeldElsewhere) {
        throw new Error(
          `The data directory ${store} is already open by process ${holder}. Stop that router, or give this one its own DATA_DIR.`,
        );
      }
      fs.rmSync(lock, { force: true });
    }
  }
  throw new Error(`Could not claim the data directory ${store}: ${lock} keeps being retaken.`);
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
