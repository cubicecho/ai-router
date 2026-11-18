import { z } from 'zod';
import { nameSchema } from '../core/names.ts';
import { isJoinableServerName } from './naming.ts';

/**
 * The shapes a server is stored and run with, shared by the tables, the installer, instances and
 * server login. Ported from mcp-router's `shared/src/config.ts`; header values and secret env
 * values are not here, because they live in `server_secrets` and are never served.
 */

/** The name kept for the admin server. No server may take it. */
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
} as const;
export type SourceType = (typeof SourceType)[keyof typeof SourceType];

/** A program the router starts and talks to over stdin and stdout. */
export const TRANSPORT_STDIO = 'stdio' as const;
/** A server reached over streamable HTTP. */
export const TRANSPORT_STREAMABLE_HTTP = 'streamable-http' as const;
/** One of the transports. */
export type TransportType = typeof TRANSPORT_STDIO | typeof TRANSPORT_STREAMABLE_HTTP;

/** Where a server came from, by `type`. */
export const serverSourceSchema = z.discriminatedUnion('type', [
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
export type ServerSource = z.infer<typeof serverSourceSchema>;

/**
 * How the router reaches a server, as stored: no header values, which are secrets.
 *
 * @remarks
 * A stdio command runs as the server's own user, in its install folder unless `cwd` says otherwise.
 */
export const serverTransportSchema = z.discriminatedUnion('type', [
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
]);
export type ServerTransport = z.infer<typeof serverTransportSchema>;

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
    | { type: typeof TRANSPORT_STREAMABLE_HTTP; url: string; headers: Record<string, string> };
  /** The env the program gets on top of the router's allowlist, secret values included. Empty for HTTP. */
  env: Record<string, string>;
  /** The user id a stdio program runs as. null for a server reached over HTTP. */
  childUid: number | null;
  /** The server's own folder, its HOME. null for a server reached over HTTP. */
  installDir: string | null;
  /** Stops an idle stdio program after this long. */
  idleTimeoutMs: number;
  /** How long one tool call may take. */
  callTimeoutMs: number;
}
