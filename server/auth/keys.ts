import { createHash, randomBytes } from 'node:crypto';
import { KEY_DEFAULTS } from '../core/defaults.ts';
import type { Snapshot, SnapshotKey } from '../db/snapshot.ts';

/** What every workspace key starts with, so a leaked one is recognisable as the router's. */
export const KEY_PREFIX = 'air_';

/** A key as it is made: the secret, which is shown once, and what is stored about it. */
export interface MintedKey {
  /** The whole key, for the app. Never stored or logged. */
  secret: string;
  /** What the table keeps to find it again. */
  hash: string;
  /** The prefix and first characters, kept in the clear. */
  start: string;
}

/**
 * Hashes a key the way the table stores it.
 *
 * @param secret - The whole key.
 * @returns Its SHA-256, in hex.
 */
export function hashKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Makes a new workspace key.
 *
 * @returns The secret and what is stored about it.
 */
export function mintKey(): MintedKey {
  const secret = `${KEY_PREFIX}${randomBytes(KEY_DEFAULTS.secretBytes).toString('base64url')}`;
  return { secret, hash: hashKey(secret), start: secret.slice(0, KEY_PREFIX.length + KEY_DEFAULTS.visibleChars) };
}

/**
 * Finds the live key a secret belongs to, in the snapshot.
 *
 * @param snapshot - What the gateways route by.
 * @param secret - The key as the request sent it.
 * @param now - The time to judge expiry by.
 * @returns The key, or null for one that is unknown, revoked, expired or whose workspace is gone.
 */
export function findKey(snapshot: Snapshot, secret: string, now: Date): SnapshotKey | null {
  const key = snapshot.keys.get(hashKey(secret)) ?? null;
  if (key === null) {
    return null;
  }
  const hasExpired = key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime();
  const isOrphaned = snapshot.workspaces.has(key.workspaceId) === false;
  if (hasExpired || isOrphaned) {
    return null;
  }
  return key;
}
