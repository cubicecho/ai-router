import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, genericOAuth, oneTimeToken } from 'better-auth/plugins';
import { appUrl, authSecret, OIDC_PROVIDER_ID, type OidcConfig, oidcConfig, serverUrl } from '../core/config.ts';
import { AUTH_DEFAULTS } from '../core/defaults.ts';
import { SECONDS_PER_DAY } from '../core/wire.ts';
import type { DB } from '../db/client.ts';
import { accounts, sessions, users, verifications } from '../db/schema.ts';
import { Role } from '../db/tables/users.ts';
import { claimFirstAdmin } from './admin.ts';

/** Overrides for tests. Production uses the defaults. */
export interface AuthOptions {
  /** What better-auth signs with. The default is `authSecret()`. */
  secret?: string;
  /** The OIDC provider to sign in with, or null for none. The default is `oidcConfig()`, the environment's. */
  oidc?: OidcConfig | null;
}

/**
 * Builds the better-auth instance. Server code calls `auth.api.*`, and none of its REST routes are mounted.
 *
 * @param db - The database users and sessions are kept in.
 * @param [options] - Test overrides.
 * @returns The auth instance.
 */
export function createAuth(db: DB, { secret = authSecret(), oidc = oidcConfig() }: AuthOptions = {}) {
  return betterAuth({
    // The rc drizzle instance is keyed by relations, so the adapter cannot discover tables itself.
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    secret,
    // The OIDC callback is served here (http/sso.ts), which in development is not the UI's origin.
    baseURL: serverUrl(),
    trustedOrigins: [new URL(appUrl()).origin],
    advanced: { database: { generateId: 'uuid' } },
    session: { expiresIn: AUTH_DEFAULTS.sessionTtlDays * SECONDS_PER_DAY },
    // So a session carries its user's role, and reading the caller costs one lookup.
    user: { additionalFields: { role: { type: 'string', input: false, defaultValue: Role.User } } },
    // Every way an account is made goes through better-auth's adapter, so this is where the first becomes admin.
    databaseHooks: { user: { create: { after: async (user) => claimFirstAdmin(db, user.id) } } },
    // An address the router's own provider vouches for signs in to the account that has it.
    ...(oidc ? { account: { accountLinking: { requireLocalEmailVerified: false } } } : {}),
    // Where an OIDC callback goes when it cannot tell where the sign-in came from.
    onAPIError: { errorURL: `${appUrl()}/login` },
    plugins: [
      // The UI sends its session back as `Authorization: Bearer`.
      bearer(),
      // How an OIDC sign-in reaches the UI: the callback mints one, and /auth/sso spends it over GraphQL.
      oneTimeToken({
        expiresIn: AUTH_DEFAULTS.oneTimeTokenTtlMinutes,
        storeToken: 'hashed',
        disableClientRequest: true,
        disableSetSessionCookie: true,
      }),
      ...(oidc ? [oidcPlugin(oidc)] : []),
    ],
  });
}

/** The better-auth instance `createAuth` builds. */
export type Auth = ReturnType<typeof createAuth>;

/**
 * The OIDC provider, through better-auth's generic OAuth plugin, which runs the flow (state, PKCE, nonce).
 *
 * @param oidc - The provider.
 * @returns The plugin.
 */
function oidcPlugin(oidc: OidcConfig) {
  return genericOAuth({
    config: [
      {
        providerId: OIDC_PROVIDER_ID,
        name: oidc.name,
        discoveryUrl: `${oidc.issuer}/.well-known/openid-configuration`,
        requireIdTokenVerification: true,
        clientId: oidc.clientId,
        clientSecret: oidc.clientSecret,
        tokenEndpointAuth: { method: oidc.clientSecret ? oidc.clientAuth : 'none' },
        pkce: true,
        scopes: ['openid', 'profile', 'email'],
        // A provider may release only a username, or no name at all.
        mapProfileToUser: (profile) => ({
          name:
            stringClaim(profile.name) ??
            stringClaim(profile.preferred_username) ??
            stringClaim(profile.email)?.split('@')[0] ??
            '',
        }),
      },
    ],
  });
}

/**
 * Reads a claim that should be text.
 *
 * @param value - The claim as the provider sent it.
 * @returns The text, or undefined when it is missing, blank or not a string.
 */
function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Who a live session belongs to. */
export interface SessionUser {
  userId: string;
  role: Role;
}

/**
 * Reads who a request's session belongs to.
 *
 * @param auth - The auth instance.
 * @param headers - The request's headers, carrying `Authorization: Bearer`.
 * @returns The user and their role, or null when there is no live session.
 */
export async function sessionUser(auth: Auth, headers: Headers): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers });
  if (session === null) {
    return null;
  }
  const role = session.user.role === Role.Admin ? Role.Admin : Role.User;
  return { userId: session.user.id, role };
}
