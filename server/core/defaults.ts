// Every value someone might tune, as plain data. Nothing here computes, reads the environment or imports.

/** Settings for the HTTP doors and the process behind them. */
export interface HttpSettings {
  /** The port to listen on. `PORT` overrides it. */
  port: number;
  /** Largest JSON body /graphql accepts, as `express.json` reads it. Real operations are a few kB. */
  bodyLimit: string;
  /** How long a browser may keep a hashed bundle without asking again. */
  immutableCacheSeconds: number;
  /** How long shutdown lets open requests finish before it cuts them. */
  drainSeconds: number;
  /** How long shutdown may take in all before a hard exit. Keep it under Docker's 10 s. */
  shutdownDeadlineSeconds: number;
  /** Express `trust proxy`: which hops may set X-Forwarded-For. False trusts none. `TRUST_PROXY` overrides it. */
  trustProxy: boolean | number | string;
}

export const HTTP_DEFAULTS: Readonly<HttpSettings> = Object.freeze({
  port: 3000,
  bodyLimit: '1mb',
  immutableCacheSeconds: 31_536_000,
  drainSeconds: 5,
  shutdownDeadlineSeconds: 8,
  trustProxy: false,
});

/** Settings for reaching Postgres. */
export interface DatabaseSettings {
  /** How long boot waits for Postgres before giving up. `DB_CONNECT_TIMEOUT_MS` overrides it. */
  connectTimeoutMs: number;
  /** The wait before the first retry. */
  firstRetryDelayMs: number;
  /** The longest wait between two retries. */
  maxRetryDelayMs: number;
  /** How much the wait grows after each failed attempt. */
  retryBackoffFactor: number;
}

export const DATABASE_DEFAULTS: Readonly<DatabaseSettings> = Object.freeze({
  connectTimeoutMs: 60_000,
  firstRetryDelayMs: 500,
  maxRetryDelayMs: 5_000,
  retryBackoffFactor: 2,
});

/** Bounds on one GraphQL operation. */
export interface OperationLimitSettings {
  /** Rows a list returns when the request names no `limit`. */
  defaultPageSize: number;
  /** The largest `limit` a request may ask for. Larger is refused, not trimmed. */
  maxPageSize: number;
  /** Deepest selection accepted. */
  maxDepth: number;
  /** Aliases per operation. */
  maxAliases: number;
  /** Cost per operation. One full page of rows with about 10 fields fits. A page of full pages doesn't. */
  maxCost: number;
  /** What a field costs when nothing prices it. */
  defaultFieldCost: number;
}

export const OPERATION_LIMIT_DEFAULTS: Readonly<OperationLimitSettings> = Object.freeze({
  defaultPageSize: 50,
  maxPageSize: 500,
  maxDepth: 8,
  maxAliases: 15,
  maxCost: 10_000,
  defaultFieldCost: 1,
});

/** The sign-in throttle. */
export interface RateLimitSettings {
  /** Attempts allowed per key inside one window. */
  maxAttempts: number;
  /** How long an attempt counts against its key. */
  windowMinutes: number;
  /** Past this many keys, a hit sweeps out the ones whose window has passed. */
  sweepAtKeys: number;
}

export const RATE_LIMIT_DEFAULTS: Readonly<RateLimitSettings> = Object.freeze({
  maxAttempts: 5,
  windowMinutes: 15,
  sweepAtKeys: 10_000,
});

/** Sign-in and credential settings. */
export interface AuthSettings {
  /** How long a session lasts after it was last used. Long: there is no password to fall back on. */
  sessionTtlDays: number;
  /** Shortest signing secret production accepts, in characters. `openssl rand -hex 32` gives twice this. */
  minSecretLength: number;
  /** Whether opening the UI signs in as the admin. `SECURE_LOCAL_NET` overrides it. */
  secureLocalNet: boolean;
  /** How long the token an OIDC callback hands the UI works: the hop from the callback to `/auth/sso`. */
  oneTimeTokenTtlMinutes: number;
  /** What the login page's OIDC button calls the provider. `OIDC_NAME` overrides it. */
  oidcName: string;
  /** How a confidential OIDC client sends its secret. `OIDC_CLIENT_AUTH` overrides it. */
  oidcClientAuth: 'client_secret_basic' | 'client_secret_post';
  /** How long pairing waits on the provider before calling it unreachable. */
  oidcPairingTimeoutMs: number;
}

export const AUTH_DEFAULTS: Readonly<AuthSettings> = Object.freeze({
  sessionTtlDays: 30,
  minSecretLength: 32,
  secureLocalNet: false,
  oneTimeTokenTtlMinutes: 3,
  oidcName: 'SSO',
  // The default the OIDC spec names.
  oidcClientAuth: 'client_secret_basic',
  oidcPairingTimeoutMs: 10_000,
});

/** Workspace keys. */
export interface KeySettings {
  /** Random bytes in a new key, before encoding. */
  secretBytes: number;
  /** How many characters of a key, after its prefix, are kept in the clear so a list can tell keys apart. */
  visibleChars: number;
}

export const KEY_DEFAULTS: Readonly<KeySettings> = Object.freeze({
  secretBytes: 32,
  visibleChars: 6,
});

/** Limits on what a workspace may hold. */
export interface WorkspaceSettings {
  /** Longest slug, in characters. */
  maxSlugLength: number;
  /** Longest name, in characters. */
  maxNameLength: number;
  /** Longest description, in characters. */
  maxDescriptionLength: number;
  /** Longest key name, in characters. */
  maxKeyNameLength: number;
  /** Longest key lifetime a person may choose, in days. */
  maxKeyExpiryDays: number;
}

export const WORKSPACE_DEFAULTS: Readonly<WorkspaceSettings> = Object.freeze({
  maxSlugLength: 64,
  maxNameLength: 120,
  maxDescriptionLength: 2_000,
  maxKeyNameLength: 120,
  maxKeyExpiryDays: 3_650,
});

/** Running MCP servers as their own users. */
export interface ChildSettings {
  /** Where the image installs `run-as-child`. `RUN_AS_CHILD` overrides it. */
  helperPath: string;
  /** The lowest uid and gid a server may be given. The helper refuses anything outside the range. */
  uidMin: number;
  /** The highest uid and gid a server may be given. */
  uidMax: number;
  /** How long the boot check may wait on the helper. */
  checkTimeoutMs: number;
}

export const CHILD_DEFAULTS: Readonly<ChildSettings> = Object.freeze({
  helperPath: '/usr/local/bin/run-as-child',
  uidMin: 10_000,
  uidMax: 19_999,
  checkTimeoutMs: 5_000,
});
