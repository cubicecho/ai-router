import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRateLimiter, type RateLimiter } from '../../server/auth/rate-limit.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { MS_PER_SECOND, SECONDS_PER_MINUTE } from '../../server/core/wire.ts';
import { closeTestDb, createClient, createTestDb, resetTestDb, TEST_IP, type TestDb } from '../helpers.ts';

const TRUSTED = 'mutation { signInOnTrustedNetwork { token } }';
const VERIFY = 'mutation ($token: String!) { verifyOneTimeToken(token: $token) { token } }';

const SETTINGS = { maxAttempts: 2, windowMinutes: 1 };
const WINDOW_SECONDS = SETTINGS.windowMinutes * SECONDS_PER_MINUTE;
const WINDOW_MS = WINDOW_SECONDS * MS_PER_SECOND;
const OTHER_IP = '203.0.113.7';

let clock: number;
let limiter: RateLimiter;

beforeEach(() => {
  clock = 0;
  limiter = createRateLimiter(SETTINGS, () => clock);
});

/** The `extensions` of what `hit` throws, or undefined when it lets the attempt through. */
function refusal(...keys: string[]): Record<string, unknown> | undefined {
  try {
    limiter.hit(...keys);
    return undefined;
  } catch (error) {
    return error instanceof Error && 'extensions' in error ? (error.extensions as Record<string, unknown>) : {};
  }
}

describe('createRateLimiter', () => {
  it('lets a key through up to its budget, then refuses with the wait', () => {
    expect(refusal('a')).toBeUndefined();
    clock = 10 * MS_PER_SECOND;
    expect(refusal('a')).toBeUndefined();
    clock = 20 * MS_PER_SECOND;
    // The first attempt, at 0, leaves the window at 60 s: 40 s from now.
    expect(refusal('a')).toEqual({ code: ErrorCode.TooManyRequests, retryAfter: WINDOW_SECONDS - 20 });
  });

  it('counts keys separately', () => {
    limiter.hit('a');
    limiter.hit('a');
    expect(refusal('b')).toBeUndefined();
  });

  it('slides: an attempt is forgotten one window after it was made', () => {
    limiter.hit('a');
    clock = 30 * MS_PER_SECOND;
    limiter.hit('a');
    clock = WINDOW_MS;
    expect(refusal('a')).toBeUndefined();
    expect(refusal('a')).toBeDefined();
  });

  it('refuses when any one key is spent, and charges none of them', () => {
    limiter.hit('ip');
    limiter.hit('ip');
    expect(refusal('ip', 'email')).toBeDefined();
    // `email` was not charged for the refused attempt, so its budget is whole.
    expect(refusal('email')).toBeUndefined();
    expect(refusal('email')).toBeUndefined();
  });

  it('does not let refused attempts hold the door shut', () => {
    limiter.hit('a');
    limiter.hit('a');
    clock = WINDOW_MS - 1;
    expect(refusal('a')).toBeDefined();
    clock = WINDOW_MS;
    expect(refusal('a')).toBeUndefined();
  });

  it('takes back a refunded attempt, on every key it was charged to', () => {
    limiter.hit('ip', 'email')();
    limiter.hit('ip', 'email')();
    limiter.hit('ip', 'email');
    expect(refusal('ip')).toBeUndefined();
    expect(refusal('email')).toBeUndefined();
    expect(refusal('ip')).toBeDefined();
  });

  it('counts an attempt in flight until it is refunded, so a burst cannot pass at once', () => {
    const inFlight = [limiter.hit('a'), limiter.hit('a')];
    expect(refusal('a')).toBeDefined();
    for (const refund of inFlight) {
      refund();
    }
    expect(refusal('a')).toBeUndefined();
  });

  it('refunds only its own attempt, and nothing once that has left the window', () => {
    const late = limiter.hit('a');
    clock = WINDOW_MS;
    limiter.hit('a');
    late();
    limiter.hit('a');
    expect(refusal('a')).toBeDefined();
  });

  it('forgets quiet keys once it holds too many', () => {
    const small = createRateLimiter({ ...SETTINGS, maxAttempts: 1, sweepAtKeys: 2 }, () => clock);
    small.hit('a');
    small.hit('b');
    clock = WINDOW_MS;
    // The third key trips the sweep; `a` and `b` have aged out and are dropped.
    small.hit('c');
    expect(() => small.hit('a')).not.toThrow();
  });
});

describe('sign-in throttling', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(() => closeTestDb(db));

  beforeEach(async () => {
    await resetTestDb(db);
    vi.stubEnv('SECURE_LOCAL_NET', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('limits spending a one-time token, valid or not', async () => {
    const client = await createClient(db, null, { limiter });
    expect((await client.expectError(VERIFY, { token: 'not-a-token' })).code).toBe(ErrorCode.BadUserInput);
    expect((await client.expectError(VERIFY, { token: 'nor-this' })).code).toBe(ErrorCode.BadUserInput);
    const error = await client.expectError(VERIFY, { token: 'a-third' });
    expect(error.extensions).toMatchObject({ code: ErrorCode.TooManyRequests, retryAfter: WINDOW_SECONDS });
  });

  it('never counts a trusted-network sign-in that succeeds', async () => {
    const client = await createClient(db, null, { limiter });
    for (let attempt = 0; attempt <= SETTINGS.maxAttempts; attempt += 1) {
      await client.expectOk(TRUSTED);
    }
  });

  it('limits trusted-network sign-ins that fail', async () => {
    vi.stubEnv('SECURE_LOCAL_NET', 'false');
    const client = await createClient(db, null, { limiter });
    expect((await client.expectError(TRUSTED)).code).toBe(ErrorCode.Forbidden);
    expect((await client.expectError(TRUSTED)).code).toBe(ErrorCode.Forbidden);
    expect((await client.expectError(TRUSTED)).code).toBe(ErrorCode.TooManyRequests);
  });

  it('counts each address on its own', async () => {
    const here = await createClient(db, null, { limiter, ip: TEST_IP });
    await here.expectError(VERIFY, { token: 'not-a-token' });
    await here.expectError(VERIFY, { token: 'nor-this' });
    const there = await createClient(db, null, { limiter, ip: OTHER_IP });
    expect((await there.expectError(VERIFY, { token: 'a-third' })).code).toBe(ErrorCode.BadUserInput);
  });

  it('gives each step a budget of its own', async () => {
    const client = await createClient(db, null, { limiter });
    await client.expectError(VERIFY, { token: 'not-a-token' });
    await client.expectError(VERIFY, { token: 'nor-this' });
    await client.expectOk(TRUSTED);
  });
});
