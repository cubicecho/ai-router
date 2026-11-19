import { z } from 'zod';
import type { AdminRole } from '../core/admin-roles.ts';
import { nameSchema } from '../core/names.ts';
import type { ChildUser } from './child-users.ts';
import { isJoinableServerName } from './naming.ts';

/**
 * The shapes a server is stored and run with, shared by the tables, the installer, instances and
 * server login. Ported from mcp-router's `shared/src/config.ts`; header values and secret env
 * values are not here, because they live in `server_secrets` and are never served.
 */

/** The admin server's name, kept for it: no other server may take it. */
export const RESERVED_SERVER_NAME = 'ai-router';

/** A server's name: the router name rule, minus the reserved name. Tools are named `<server>__<tool>`. */
export const serverNameSchema = nameSchema('Name')
  .refine((name) => name !== RESERVED_SERVER_NAME, {
    message: `"${RESERVED_SERVER_NAME}" is kept for the router's own admin server.`,
  })
  .refine(isJoinableServerName, {
    message: 'A server name may not hold "__" or end in "_": a run names its tools <server>__<tool>.',
  });

/** Where a server came from. */
export const SourceType = {
  /** Installed from a registry. */
  Registry: 'registry',
  /** Installed from npm. */
  Npm: 'npm',
  /** A PyPI package run with `uvx`. */
  Pypi: 'pypi',
  /** Added by hand by its command or address: nothing was installed. */
  Manual: 'manual',
  /** The router's own: only the admin server, which the migrations add. */
  Builtin: 'builtin',
} as const;
export type SourceType = (typeof SourceType)[keyof typeof SourceType];

/** A program the router starts and talks to over stdin and stdout. */
export const TRANSPORT_STDIO = 'stdio' as const;
/** A server reached over streamable HTTP. */
export const TRANSPORT_STREAMABLE_HTTP = 'streamable-http' as const;
/** A server reached over the older HTTP+SSE transport: it streams events from one address, and takes posts at another. */
export const TRANSPORT_SSE = 'sse' as const;
/** The admin server, served inside the router and connected to in process. Only `ai-router` has it. */
export const TRANSPORT_BUILTIN = 'builtin' as const;

/** The transports that reach a server at an address, with headers and, where it has one, a login. */
export const HTTP_TRANSPORTS = Object.freeze([TRANSPORT_STREAMABLE_HTTP, TRANSPORT_SSE] as const);
/** A transport that reaches a server at an address. */
export type HttpTransportType = (typeof HTTP_TRANSPORTS)[number];

/**
 * Reads a transport's name as one of the HTTP transports.
 *
 * @param type - A transport's `type`, such as a registry remote's.
 * @returns It, when it is streamable HTTP or SSE; otherwise undefined.
 */
export function httpTransportType(type: string): HttpTransportType | undefined {
  return HTTP_TRANSPORTS.find((candidate) => candidate === type);
}

/**
 * Whether a transport reaches its server at an address, rather than starting a program or connecting in process.
 *
 * @typeParam T - The transport's shape: stored, resolved or as a person gave it.
 * @param transport - The transport.
 * @returns true for streamable HTTP and SSE.
 */
export function isHttpTransport<T extends { type: string }>(
  transport: T,
): transport is Extract<T, { type: HttpTransportType }> {
  return httpTransportType(transport.type) !== undefined;
}

/** Where a server can be installed or added from: anywhere but the router itself. */
export const installSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(SourceType.Registry),
    /** The registry's name. */
    registry: z.string(),
    /** The entry's name in the registry, such as `io.github.owner/repo`. */
    serverName: z.string(),
    version: z.string().optional(),
  }),
  z.object({ type: z.literal(SourceType.Npm), package: z.string(), version: z.string().optional() }),
  z.object({ type: z.literal(SourceType.Pypi), package: z.string(), version: z.string().optional() }),
  z.object({ type: z.literal(SourceType.Manual) }),
]);
export type InstallSource = z.infer<typeof installSourceSchema>;

/** Where a server came from, by `type`: one of the install sources, or the router itself. */
export const serverSourceSchema = z.discriminatedUnion('type', [
  ...installSourceSchema.options,
  z.object({ type: z.literal(SourceType.Builtin) }),
]);
export type ServerSource = z.infer<typeof serverSourceSchema>;

/**
 * How the router reaches a server outside it, as a person gives it: no header values, which are secrets.
 *
 * @remarks
 * A stdio command runs as the server's own user, in its install folder unless `cwd` says otherwise.
 */
export const externalTransportSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(TRANSPORT_STDIO),
    /** The program, such as `node`, `uvx` or an absolute path. Never run through a shell. */
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
  }),
  z.object({
    type: z.literal(TRANSPORT_STREAMABLE_HTTP),
    url: z.url(),
  }),
  z.object({
    type: z.literal(TRANSPORT_SSE),
    /** The event stream's address. The server names where messages are posted once it is open. */
    url: z.url(),
  }),
]);

/** How the router reaches a server, as stored: a server outside it, or the built-in admin server. */
export const serverTransportSchema = z.discriminatedUnion('type', [
  ...externalTransportSchema.options,
  z.object({ type: z.literal(TRANSPORT_BUILTIN) }),
]);
export type ServerTransport = z.infer<typeof serverTransportSchema>;

/** The admin server's row, as the migrations add it. Only `enabled`, `displayName` and `description` may change. */
export const ADMIN_SERVER_ROW = Object.freeze({
  name: RESERVED_SERVER_NAME,
  displayName: 'Admin server',
  description:
    "The router's own management, as tools. A workspace's entry for it grants roles, and an agent reaches it only by naming it.",
  source: Object.freeze({ type: SourceType.Builtin }),
  transport: Object.freeze({ type: TRANSPORT_BUILTIN }),
});

/** What the UI shows for one env var, from the registry's description of it. */
export const envVarMetaSchema = z
  .object({
    description: z.string().optional(),
    isRequired: z.boolean().optional(),
    isSecret: z.boolean().optional(),
    default: z.string().optional(),
    placeholder: z.string().optional(),
    choices: z.array(z.string()).optional(),
  })
  .loose();
export type EnvVarMeta = z.infer<typeof envVarMetaSchema>;

/**
 * A remote server's login, as the router keeps it in `servers.oauth`, which is never served.
 *
 * @remarks
 * `clientId` and `clientSecret` are typed by hand, for a login that only knows clients it was told
 * about. The router writes the rest: the client the login registered, the redirect URI it was set up
 * with, and the tokens.
 */
export const serverOAuthSchema = z
  .object({
    /** A client id given by hand. Wins over a registered one. */
    clientId: z.string().min(1).optional(),
    /** The secret of `clientId`, for a login that issues confidential clients. */
    clientSecret: z.string().min(1).optional(),
    /** Scopes to ask for when the server does not say which it wants. */
    scope: z.string().min(1).optional(),
    /** The redirect URI the client and tokens were obtained with. */
    redirectUri: z.url().optional(),
    /** What the login answered a registration with (RFC 7591), or the metadata-URL id. */
    clientInformation: z.record(z.string(), z.unknown()).optional(),
    /** The token response: access token, refresh token, expiry in seconds. */
    tokens: z.record(z.string(), z.unknown()).optional(),
    /** When `tokens` was saved, ISO. With `tokens.expires_in` it dates the access token. */
    tokensSavedAt: z.string().optional(),
  })
  .loose();
export type ServerOAuth = z.infer<typeof serverOAuthSchema>;

/**
 * Everything an instance needs to run one server, with secrets filled in: what `tools/instance`
 * starts or connects to. For a workspace instance, the workspace's overrides are already merged in.
 */
export interface ResolvedServer {
  id: string;
  name: string;
  /** null for the base instance. */
  workspaceId: string | null;
  transport:
    | { type: typeof TRANSPORT_STDIO; command: string; args: string[]; cwd?: string }
    | { type: HttpTransportType; url: string; headers: Record<string, string> }
    | {
        type: typeof TRANSPORT_BUILTIN;
        /** What the instance's workspace grants its runs: its entry's roles, or every role to list for a person. */
        roles: AdminRole[];
      };
  /** The env the program gets on top of the router's allowlist, secret values included. Empty for HTTP. */
  env: Record<string, string>;
  /**
   * Who a stdio program runs as: the server's uid and group for the base instance, the entry's own uid with the
   * server's group for a workspace instance, and the server's extra groups either way. null for a server reached over
   * HTTP or built in.
   */
  runAs: ChildUser | null;
  /** The server's install folder: its packages, and where its program starts. null for a server reached over HTTP. */
  installDir: string | null;
  /**
   * The program's HOME: inside the server's folder for the base instance, inside the entry's own for a workspace
   * instance. null for a server reached over HTTP, and for a workspace instance whose folder isn't made yet.
   */
  homeDir: string | null;
  /** Stops an idle stdio program after this long. */
  idleTimeoutMs: number;
  /** How long one tool call may take. */
  callTimeoutMs: number;
}
