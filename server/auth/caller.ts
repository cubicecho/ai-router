import {
  CALLER_USER,
  CALLER_WORKER,
  CALLER_WORKSPACE,
  type Caller,
  type UserCaller,
  type WorkerCaller,
  type WorkspaceCaller,
} from '../core/context.ts';
import { forbidden, unauthenticated } from '../core/errors.ts';
import type { Snapshot } from '../db/snapshot.ts';
import { type Auth, sessionUser } from './better-auth.ts';
import { findKey, findWorkerKey, isWorkerKey } from './keys.ts';

/** The header an app may send its key in, beside or instead of `Authorization: Bearer`. */
export const API_KEY_HEADER = 'x-api-key';
/** The scheme a key or a session token is sent under. */
const BEARER_SCHEME = /^bearer\s+/i;

/** A request that sent a key two ways, and the two differ. Each door answers it in its own format. */
export class ConflictingKeysError extends Error {
  /** Builds the error. */
  constructor() {
    super('The request sends two different keys, in Authorization and x-api-key. Send one.');
    this.name = 'ConflictingKeysError';
  }
}

/** The credentials a request presents. */
interface Presented {
  /** From `Authorization: Bearer`: a workspace or worker key, or a person's session token. */
  bearer: string | null;
  /** From `x-api-key`: only ever a workspace or worker key. */
  apiKey: string | null;
}

/**
 * Reads the credentials a request presents.
 *
 * @param headers - The request's headers.
 * @returns The bearer and `x-api-key` values, each null when absent or blank.
 * @throws {@link ConflictingKeysError} When both are sent and differ.
 */
function presented(headers: Headers): Presented {
  const authorization = headers.get('authorization') ?? '';
  const hasBearer = BEARER_SCHEME.test(authorization);
  const bearer = hasBearer ? authorization.replace(BEARER_SCHEME, '').trim() : '';
  const apiKey = headers.get(API_KEY_HEADER)?.trim() ?? '';
  const isConflicting = bearer !== '' && apiKey !== '' && bearer !== apiKey;
  if (isConflicting) {
    throw new ConflictingKeysError();
  }
  return { bearer: bearer === '' ? null : bearer, apiKey: apiKey === '' ? null : apiKey };
}

/** What reading a caller needs beyond the headers. */
export interface CallerSources {
  /** The auth instance for this request, which knows sessions. */
  auth: Auth;
  /** What keys are checked against. */
  snapshot: Snapshot;
  /** The time to judge a key's expiry by. */
  now: Date;
}

/**
 * Reads who a request is from.
 *
 * @param sources - The auth instance, the snapshot and the time.
 * @param headers - The request's headers.
 * @returns A workspace for a live key, a user for a live session, or null for nobody.
 * @throws {@link ConflictingKeysError} When the request sends two different keys.
 *
 * @remarks
 * `x-api-key` is only ever a key, and one that does not hold is nobody, never a fall through to a session.
 * A bearer is tried as a workspace key first, then as a session token. A worker key is nobody here.
 */
export async function readCaller({ auth, snapshot, now }: CallerSources, headers: Headers): Promise<Caller | null> {
  const workspace = readWorkspaceCaller(snapshot, headers, now);
  if (workspace !== null) {
    return workspace;
  }
  const { bearer, apiKey } = presented(headers);
  if (apiKey !== null || bearer === null || isWorkerKey(bearer)) {
    return null;
  }
  const user = await sessionUser(auth, headers);
  return user === null ? null : { kind: CALLER_USER, ...user };
}

/**
 * Reads the app a request is from, by its workspace key alone. For the doors only apps use, where a session is
 * never read, on a trusted network too.
 *
 * @param snapshot - What keys are checked against.
 * @param headers - The request's headers.
 * @param now - The time to judge a key's expiry by.
 * @returns The workspace for a live key, or null, for a worker key too.
 * @throws {@link ConflictingKeysError} When the request sends two different keys.
 */
export function readWorkspaceCaller(snapshot: Snapshot, headers: Headers, now: Date): WorkspaceCaller | null {
  const { bearer, apiKey } = presented(headers);
  const candidate = apiKey ?? bearer;
  const key = candidate === null ? null : findKey(snapshot, candidate, now);
  return key === null ? null : { kind: CALLER_WORKSPACE, workspaceId: key.workspaceId, keyId: key.keyId };
}

/**
 * Reads the remote worker a request is from, by its worker key alone. For the worker doors only, where a workspace
 * key or a session is never read.
 *
 * @param snapshot - What worker keys are checked against.
 * @param headers - The request's headers.
 * @returns The worker for a live worker key, or null, for a workspace key or a session too.
 * @throws {@link ConflictingKeysError} When the request sends two different keys.
 */
export function readWorkerCaller(snapshot: Snapshot, headers: Headers): WorkerCaller | null {
  const { bearer, apiKey } = presented(headers);
  const candidate = apiKey ?? bearer;
  const worker = candidate === null ? null : findWorkerKey(snapshot, candidate);
  return worker === null ? null : { kind: CALLER_WORKER, workerId: worker.id, name: worker.name };
}

/**
 * Reads the signed-in person a resolver acts for.
 *
 * @param caller - The request's caller.
 * @returns The user.
 * @throws UNAUTHENTICATED for nobody, FORBIDDEN for a workspace key.
 *
 * @remarks
 * Permissions refuse both first. This is what lets a resolver's types know who it acts for.
 */
export function requireUser(caller: Caller | null): UserCaller {
  if (caller === null) {
    throw unauthenticated('Sign in first.');
  }
  if (caller.kind !== CALLER_USER) {
    throw forbidden('Only a person signed in to the router can do this. A workspace key cannot.');
  }
  return caller;
}
