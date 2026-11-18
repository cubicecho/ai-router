import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedAuthHost } from '../../server/auth/auth-host.ts';
import type { Auth } from '../../server/auth/better-auth.ts';
import { sessionUser } from '../../server/auth/better-auth.ts';
import { LOCAL_ADMIN_EMAIL } from '../../server/auth/trusted-network.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { users } from '../../server/db/schema.ts';
import { Role } from '../../server/db/tables/users.ts';
import {
  closeTestDb,
  createClient,
  createTestAuth,
  createTestDb,
  createUser,
  resetTestDb,
  type TestDb,
} from '../helpers.ts';

const SIGN_IN = 'mutation { signInOnTrustedNetwork { token userId } }';
const AUTH_CONFIG = '{ authConfig { trustedNetwork sso { name } } }';

let db: TestDb;
let auth: Auth;

beforeAll(async () => {
  db = await createTestDb();
  auth = createTestAuth(db);
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('on a trusted network', () => {
  beforeEach(() => {
    vi.stubEnv('SECURE_LOCAL_NET', 'true');
  });

  it('signs whoever opened the UI in as the local admin', async () => {
    const client = await createClient(db, null, { authHost: fixedAuthHost(auth) });
    const { signInOnTrustedNetwork } = await client.expectOk(SIGN_IN);
    const headers = new Headers({ authorization: `Bearer ${signInOnTrustedNetwork.token}` });
    expect(await sessionUser(auth, headers)).toEqual({ userId: signInOnTrustedNetwork.userId, role: Role.Admin });
  });

  it('keeps one local admin across sign-ins', async () => {
    const client = await createClient(db, null, { authHost: fixedAuthHost(auth) });
    const first = await client.expectOk(SIGN_IN);
    const second = await client.expectOk(SIGN_IN);
    expect(second.signInOnTrustedNetwork.userId).toBe(first.signInOnTrustedNetwork.userId);
    const locals = await db.select().from(users).where(eq(users.email, LOCAL_ADMIN_EMAIL));
    expect(locals).toHaveLength(1);
  });

  it('makes the local admin an admin even when someone else already is', async () => {
    await createUser(db, 'first@example.com', Role.Admin);
    const client = await createClient(db, null, { authHost: fixedAuthHost(auth) });
    const { signInOnTrustedNetwork } = await client.expectOk(SIGN_IN);
    const [local] = await db.select().from(users).where(eq(users.id, signInOnTrustedNetwork.userId));
    expect(local?.role).toBe(Role.Admin);
  });

  it('says so on the sign-in page', async () => {
    const { authConfig } = await (await createClient(db, null)).expectOk(AUTH_CONFIG);
    expect(authConfig).toEqual({ trustedNetwork: true, sso: null });
  });
});

describe('anywhere else', () => {
  it('refuses to sign anyone in', async () => {
    vi.stubEnv('SECURE_LOCAL_NET', 'false');
    const { code } = await (await createClient(db, null)).expectError(SIGN_IN);
    expect(code).toBe(ErrorCode.Forbidden);
  });
});
