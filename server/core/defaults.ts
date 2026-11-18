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

/** Router names: workspace slugs, providers, pools, and later servers and agents. */
export interface NameSettings {
  /** Longest name, in characters. */
  maxLength: number;
}

export const NAME_DEFAULTS: Readonly<NameSettings> = Object.freeze({
  maxLength: 64,
});

/** Limits on what a workspace may hold. */
export interface WorkspaceSettings {
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

/** Calling providers on a run's behalf. */
export interface ModelSettings {
  /** How long a provider may take to start answering a call, before it is a 504. A stream then runs as long as it needs. */
  responseTimeoutMs: number;
  /** How long a provider's model list is reused before it is asked again. */
  modelListCacheSeconds: number;
  /** How long a provider may take to list its models. */
  modelListTimeoutMs: number;
  /** How much of a provider's failed answer is kept in an error message. */
  errorBodyMaxChars: number;
  /** A JSON answer larger than this is passed on but not read for its token counts. */
  maxResponseBytes: number;
  /** How long an idle connection to a provider is kept for the next call. */
  keepAliveMs: number;
}

export const MODEL_DEFAULTS: Readonly<ModelSettings> = Object.freeze({
  responseTimeoutMs: 600_000,
  modelListCacheSeconds: 60,
  modelListTimeoutMs: 10_000,
  errorBodyMaxChars: 500,
  maxResponseBytes: 8_388_608,
  keepAliveMs: 30_000,
});

/** Counting usage. */
export interface UsageSettings {
  /** How often counts gathered in memory are written. A crash loses at most this much. */
  flushSeconds: number;
  /** How many days stay one row per day before they fold into the all-time row. */
  detailDays: number;
  /** How often days past the detail window are folded. */
  foldEveryHours: number;
}

export const USAGE_DEFAULTS: Readonly<UsageSettings> = Object.freeze({
  flushSeconds: 5,
  detailDays: 90,
  foldEveryHours: 24,
});

/** Limits on what a provider or a pool may hold. */
export interface ModelConfigSettings {
  /** Longest display name, in characters. */
  maxDisplayNameLength: number;
  /** Longest description, in characters. */
  maxDescriptionLength: number;
  /** Most headers one provider may send. */
  maxHeaders: number;
  /** Longest header value, in characters. */
  maxHeaderValueLength: number;
  /** Longest API key, in characters. */
  maxApiKeyLength: number;
  /** Most targets one pool may have. */
  maxTargets: number;
  /** Longest model id at a provider, in characters. */
  maxModelLength: number;
}

export const MODEL_CONFIG_DEFAULTS: Readonly<ModelConfigSettings> = Object.freeze({
  maxDisplayNameLength: 120,
  maxDescriptionLength: 2_000,
  maxHeaders: 32,
  maxHeaderValueLength: 4_096,
  maxApiKeyLength: 4_096,
  maxTargets: 64,
  maxModelLength: 256,
});

/** What a server's settings, entries and secrets may hold. */
export interface ToolConfigSettings {
  /** Env vars a server, or a workspace's entry for it, may set. */
  maxEnvVars: number;
  /** Characters in one env value, secret or not. */
  maxEnvValueLength: number;
  /** Arguments a stdio server's command may have. */
  maxArgs: number;
  /** Characters in one argument, or a command. */
  maxArgLength: number;
  /** Headers an HTTP server may be sent. */
  maxHeaders: number;
  /** Characters in a secret: an env value or a header value. */
  maxSecretLength: number;
  /** The longest idle or call timeout a server may set. */
  maxTimeoutMs: number;
  /** Characters in a server's display name. */
  maxDisplayNameLength: number;
  /** Characters in a server's description. */
  maxDescriptionLength: number;
}

export const TOOL_CONFIG_DEFAULTS: Readonly<ToolConfigSettings> = Object.freeze({
  maxEnvVars: 64,
  maxEnvValueLength: 8192,
  maxArgs: 64,
  maxArgLength: 4096,
  maxHeaders: 32,
  maxSecretLength: 8192,
  maxTimeoutMs: 3_600_000,
  maxDisplayNameLength: 120,
  maxDescriptionLength: 2000,
});

/** Running MCP servers and calling their tools. */
export interface InstanceSettings {
  /** How long a stdio program may sit with no call before it is stopped, for a server that sets no time of its own. */
  idleTimeoutMs: number;
  /** How long one tool call may take, for a server that sets no time of its own. */
  callTimeoutMs: number;
  /** How long a server may take to start and answer the handshake. Long, since `npx` and `uvx` may download first. */
  startTimeoutMs: number;
  /** How long a server may take to list its tools. */
  listTimeoutMs: number;
  /** Most pages of tools read from one server. A server that pages past it is refused. */
  maxToolListPages: number;
  /** How long a failed server waits before the next start, after its first failure. */
  firstBackoffMs: number;
  /** The longest a failed server waits before the next start. */
  maxBackoffMs: number;
  /** How much the wait grows after each failure in a row. */
  backoffFactor: number;
  /** How much of a program's stderr is kept for error messages, in characters. */
  stderrTailChars: number;
  /**
   * How long a stopping program gets after its stdin closes, and again after SIGTERM, before the next signal. An
   * isolated program is signalled through `run-as-child`, since the router may not signal another user.
   */
  closeGraceMs: number;
  /** How long the helper may take to signal an isolated program. */
  signalTimeoutMs: number;
}

export const INSTANCE_DEFAULTS: Readonly<InstanceSettings> = Object.freeze({
  idleTimeoutMs: 300_000,
  callTimeoutMs: 600_000,
  startTimeoutMs: 60_000,
  listTimeoutMs: 30_000,
  maxToolListPages: 50,
  firstBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  backoffFactor: 2,
  stderrTailChars: 4_000,
  closeGraceMs: 2_000,
  signalTimeoutMs: 5_000,
});

/** Reading MCP registries. */
export interface RegistrySettings {
  /** How long a registry may take to answer one request. */
  fetchTimeoutMs: number;
  /** How much of a registry's failed answer is kept in an error message, in characters. */
  errorBodyMaxChars: number;
}

export const REGISTRY_DEFAULTS: Readonly<RegistrySettings> = Object.freeze({
  fetchTimeoutMs: 30_000,
  errorBodyMaxChars: 500,
});

/** Servers' install folders, and the commands the router runs in them as each server's user. */
export interface InstallSettings {
  /** The PATH every child process gets, whatever the router's own PATH is. */
  childPath: string;
  /** Random bytes in an install folder's name, after its uid. Hex doubles them. */
  folderRandomBytes: number;
  /** How long creating or removing an install folder may take. */
  folderTimeoutMs: number;
  /** How long one `npm install` may run before it is stopped. */
  npmTimeoutMs: number;
  /** How long reading an installed package's package.json may take. */
  readTimeoutMs: number;
  /** How long a command that overran gets after SIGTERM before SIGKILL, and the router stops waiting after that. */
  killGraceMs: number;
  /** How much of the end of a failed command's stderr is kept in its error message, in characters. */
  stderrTailChars: number;
}

export const INSTALL_DEFAULTS: Readonly<InstallSettings> = Object.freeze({
  childPath: '/usr/local/bin:/usr/bin:/bin',
  folderRandomBytes: 8,
  folderTimeoutMs: 30_000,
  npmTimeoutMs: 300_000,
  readTimeoutMs: 10_000,
  killGraceMs: 5_000,
  stderrTailChars: 1_000,
});

/** Server login: the OAuth sign-in a remote MCP server asks for. */
export interface ServerLoginSettings {
  /** How long a started login waits for its callback before its `state` stops working. */
  pendingLoginTtlMinutes: number;
  /** Random bytes in a login's `state`, which is sent as base64url. */
  stateBytes: number;
  /** How long one request of a login may take: the first knock, discovery, registration, a token exchange. */
  requestTimeoutMs: number;
  /** The router's name, as a server's login shows it on its consent page. */
  clientName: string;
  /** Longest hand-typed client id, client secret or scope, in characters. */
  maxClientFieldLength: number;
}

export const SERVER_LOGIN_DEFAULTS: Readonly<ServerLoginSettings> = Object.freeze({
  pendingLoginTtlMinutes: 10,
  stateBytes: 32,
  requestTimeoutMs: 10_000,
  clientName: 'ai-router',
  maxClientFieldLength: 4_096,
});

/** The record of tool calls. */
export interface ActivitySettings {
  /** How often calls gathered in memory are written. A crash loses at most this much. */
  flushSeconds: number;
  /** How many days a call is kept. */
  retentionDays: number;
  /** How often calls past the retention are deleted. */
  pruneEveryHours: number;
  /** Calls held in memory at most; past it the oldest are dropped, so a database outage can't fill memory. */
  maxPending: number;
  /** Characters of a failure's message kept. */
  maxErrorLength: number;
}

export const ACTIVITY_DEFAULTS: Readonly<ActivitySettings> = Object.freeze({
  flushSeconds: 5,
  retentionDays: 30,
  pruneEveryHours: 6,
  maxPending: 10_000,
  maxErrorLength: 500,
});

/** What an agent's document and its revisions may hold. */
export interface AgentConfigSettings {
  /** The largest document, as JSON, in bytes. */
  maxDocumentBytes: number;
  /** Characters in a revision's message. */
  maxMessageLength: number;
}

export const AGENT_CONFIG_DEFAULTS: Readonly<AgentConfigSettings> = Object.freeze({
  maxDocumentBytes: 262_144,
  maxMessageLength: 500,
});
