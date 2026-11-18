import { createRequire } from 'node:module';
import path from 'node:path';
import { AUTH_DEFAULTS, type AuthSettings, CHILD_DEFAULTS, DATABASE_DEFAULTS, HTTP_DEFAULTS } from './defaults.ts';

/** What `version()` answers when the root package.json cannot be read. */
const UNKNOWN_VERSION = 'unknown';
/** Env values that count as on, in lower case. */
const TRUTHY = ['1', 'true', 'yes'];
/** Env values that count as off, in lower case. */
const FALSY = ['0', 'false', 'no'];
/** A hop count: digits only. */
const HOP_COUNT = /^\d+$/;
/** A `DATABASE_URL` that names a Postgres server rather than a PGlite store. */
const POSTGRES_URL = /^postgres(ql)?:\/\//;
/** Where `DATA_DIR` points when unset: `data/` in the checkout, gitignored. */
const DEV_DATA_DIR = 'data';

/** The repository root, where package.json, drizzle/ and dist/ sit. */
export const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** What signs sessions when `BETTER_AUTH_SECRET` is unset. Preflight refuses it in production. */
export const DEV_SECRET = 'dev-secret-change-me-in-production';

/** The value `.env.example` ships. Public, so as good as no secret at all. */
export const PLACEHOLDER_SECRET = 'change-me-to-a-long-random-string';

/**
 * Why `secret` must not sign production tokens, or undefined when it may.
 *
 * @param secret - `BETTER_AUTH_SECRET` as set.
 * @returns The reason, as the end of a sentence ("is not set").
 */
export function describeWeakSecret(secret: string | undefined): string | undefined {
  if (secret === undefined || secret === '') {
    return 'is not set';
  }
  if (secret === DEV_SECRET || secret === PLACEHOLDER_SECRET) {
    return 'is a published default';
  }
  if (secret.length < AUTH_DEFAULTS.minSecretLength) {
    return `is shorter than ${AUTH_DEFAULTS.minSecretLength} characters`;
  }
  return undefined;
}

/**
 * Reads an on/off flag.
 *
 * @param value - The raw env value. "1", "true" and "yes" count as on, in any case.
 * @param fallback - Used when the value is unset or empty.
 * @returns Whether the flag is on.
 */
export function envFlag(value: string | undefined, fallback: boolean): boolean {
  const normalised = (value ?? '').trim().toLowerCase();
  if (normalised === '') {
    return fallback;
  }
  return TRUTHY.includes(normalised);
}

/**
 * Reads a positive number.
 *
 * @param value - The raw env value.
 * @param fallback - Used when the value is unset, not a number, or not above zero.
 * @returns The number.
 */
function envNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  const isUsable = Number.isFinite(parsed) && parsed > 0;
  return isUsable ? parsed : fallback;
}

/**
 * Whether this is a production instance, where the checks are strict and GraphiQL is off.
 *
 * @returns true when `NODE_ENV` is `production`.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Where the router keeps what it writes: the PGlite store, and later the servers' installs.
 *
 * @returns `DATA_DIR`, or `data/` in the checkout.
 */
export function dataDir(): string {
  const configured = process.env.DATA_DIR?.trim() ?? '';
  return configured === '' ? path.join(ROOT, DEV_DATA_DIR) : configured;
}

/**
 * The database to open: a `postgres://` URL, a PGlite store, or empty for PGlite under `DATA_DIR`.
 *
 * @returns `DATABASE_URL`, or an empty string.
 */
export function databaseUrl(): string {
  return process.env.DATABASE_URL?.trim() ?? '';
}

/**
 * Whether the database is a Postgres server rather than PGlite in this process.
 *
 * @param [url] - The database URL to judge.
 * @returns true for a `postgres://` or `postgresql://` URL.
 */
export function usesPostgres(url = databaseUrl()): boolean {
  return POSTGRES_URL.test(url);
}

/**
 * How long boot waits for Postgres.
 *
 * @returns `DB_CONNECT_TIMEOUT_MS`, or `DATABASE_DEFAULTS.connectTimeoutMs`, in milliseconds.
 */
export function dbConnectTimeoutMs(): number {
  return envNumber(process.env.DB_CONNECT_TIMEOUT_MS, DATABASE_DEFAULTS.connectTimeoutMs);
}

/**
 * `BETTER_AUTH_SECRET` exactly as set, for preflight to judge.
 *
 * @returns The secret, or undefined when unset.
 */
export function configuredAuthSecret(): string | undefined {
  return process.env.BETTER_AUTH_SECRET;
}

/**
 * What better-auth signs with.
 *
 * @returns `BETTER_AUTH_SECRET`, or the development secret when unset.
 */
export function authSecret(): string {
  return configuredAuthSecret() || DEV_SECRET;
}

/**
 * The release this instance is running, from the root package.json.
 *
 * @returns The version, or the unknown-version placeholder when the manifest cannot be read.
 *
 * @remarks
 * Read from the file, not `npm_package_version`: the image starts the server with `node`, so npm never sets it.
 */
export function version(): string {
  try {
    const manifest: unknown = createRequire(import.meta.url)(path.join(ROOT, 'package.json'));
    const isNamed = typeof manifest === 'object' && manifest !== null && 'version' in manifest;
    return isNamed && typeof manifest.version === 'string' ? manifest.version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

/**
 * The port to listen on.
 *
 * @returns `PORT`, or `HTTP_DEFAULTS.port`.
 */
export function port(): number {
  return envNumber(process.env.PORT, HTTP_DEFAULTS.port);
}

/**
 * Where people open the UI. The OIDC sign-in lands here, and it is logged at boot.
 *
 * @returns `APP_URL`, or this server's own localhost address.
 */
export function appUrl(): string {
  const configured = process.env.APP_URL?.trim().replace(/\/+$/, '') ?? '';
  return configured === '' ? `http://localhost:${port()}` : configured;
}

/**
 * Where a browser reaches this server: the OIDC sign-in's start and callback live here.
 *
 * @returns `SERVER_URL`, `APP_URL` in production, or this server's own localhost address.
 *
 * @remarks
 * In development the Vite dev server is a second origin and the API is on its own port.
 */
export function serverUrl(): string {
  const configured = process.env.SERVER_URL?.trim().replace(/\/+$/, '') ?? '';
  if (configured !== '') {
    return configured;
  }
  return isProduction() ? appUrl() : `http://localhost:${port()}`;
}

/**
 * How far to believe `X-Forwarded-For`, from `TRUST_PROXY`.
 *
 * @returns false, true, a hop count, or a value Express's `trust proxy` accepts (`loopback`, a subnet).
 *
 * @remarks
 * The sign-in limiter keys on `req.ip`: an untrusted proxy puts every client in one budget, and
 * trusting a hop that isn't a proxy lets a client pick its own address.
 */
export function trustProxy(): boolean | number | string {
  const value = (process.env.TRUST_PROXY ?? '').trim();
  if (value === '') {
    return HTTP_DEFAULTS.trustProxy;
  }
  if (HOP_COUNT.test(value)) {
    return Number(value);
  }
  if (FALSY.includes(value.toLowerCase())) {
    return false;
  }
  return TRUTHY.includes(value.toLowerCase()) ? true : value;
}

/**
 * Whether whoever opens the UI is signed in as the admin, with no OIDC round trip.
 *
 * @returns `SECURE_LOCAL_NET` as a flag, or `AUTH_DEFAULTS.secureLocalNet`.
 *
 * @remarks
 * The network is then the credential for the UI. It never lets a request without a workspace key reach
 * the app endpoints. Preflight refuses it with a public `APP_URL`.
 */
export function secureLocalNet(): boolean {
  return envFlag(process.env.SECURE_LOCAL_NET, AUTH_DEFAULTS.secureLocalNet);
}

/**
 * Whether a public `APP_URL` is accepted alongside `SECURE_LOCAL_NET`.
 *
 * @returns `I_KNOW_SECURE_LOCAL_NET_IS_PUBLIC` as a flag, off when unset.
 */
export function allowsPublicLocalNet(): boolean {
  return envFlag(process.env.I_KNOW_SECURE_LOCAL_NET_IS_PUBLIC, false);
}

/**
 * Where the helper that starts MCP servers as their own users is installed.
 *
 * @returns `RUN_AS_CHILD`, or `CHILD_DEFAULTS.helperPath`.
 */
export function runAsChildPath(): string {
  const configured = process.env.RUN_AS_CHILD?.trim() ?? '';
  return configured === '' ? CHILD_DEFAULTS.helperPath : configured;
}

/** The id the OIDC provider is registered under in better-auth, and so the last part of its callback path. */
export const OIDC_PROVIDER_ID = 'oidc';
/** The `OIDC_CLIENT_AUTH` values a provider can expect. */
export const OIDC_CLIENT_AUTH_METHODS = ['client_secret_basic', 'client_secret_post'] as const;

/** An OpenID Connect provider to sign in with: heautou, Keycloak, Authentik, … */
export interface OidcConfig {
  /** The issuer URL, no trailing slash. Its discovery document is `/.well-known/openid-configuration` under it. */
  issuer: string;
  clientId: string;
  /** Unset for a public client, which proves itself with PKCE alone. */
  clientSecret: string | undefined;
  /** How a confidential client sends its secret. The provider must expect the same. */
  clientAuth: AuthSettings['oidcClientAuth'];
  /** What the login page's button calls the provider. */
  name: string;
}

/**
 * Reads the OIDC provider set in the environment.
 *
 * @returns The provider when `OIDC_ISSUER` and `OIDC_CLIENT_ID` are both set, otherwise null.
 *
 * @remarks
 * preflight.ts refuses one of the two without the other, and an `OIDC_CLIENT_AUTH` it does not know.
 */
export function oidcConfig(): OidcConfig | null {
  const issuer = process.env.OIDC_ISSUER?.trim() ?? '';
  const clientId = process.env.OIDC_CLIENT_ID?.trim() ?? '';
  if (issuer === '' || clientId === '') {
    return null;
  }
  const clientAuth = process.env.OIDC_CLIENT_AUTH?.trim();
  return {
    issuer: issuer.replace(/\/+$/, ''),
    clientId,
    clientSecret: process.env.OIDC_CLIENT_SECRET?.trim() || undefined,
    clientAuth: clientAuth === 'client_secret_post' ? clientAuth : AUTH_DEFAULTS.oidcClientAuth,
    name: process.env.OIDC_NAME?.trim() || AUTH_DEFAULTS.oidcName,
  };
}

/**
 * Names the address to register with the OIDC provider as this client's redirect URI.
 *
 * @returns better-auth's callback for the provider, under `serverUrl()`.
 */
export function oidcRedirectUri(): string {
  return `${serverUrl()}/api/auth/callback/${OIDC_PROVIDER_ID}`;
}
