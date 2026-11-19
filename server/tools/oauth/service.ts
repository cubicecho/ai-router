import { randomBytes } from 'node:crypto';
import { auth, extractWWWAuthenticateParams, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { version } from '../../core/config.ts';
import { SERVER_LOGIN_DEFAULTS, type ServerLoginSettings } from '../../core/defaults.ts';
import { badInput, errorMessage, notFound, upstreamFailed } from '../../core/errors.ts';
import { parseOrThrow } from '../../core/validation.ts';
import { HttpStatus, MS_PER_SECOND, SECONDS_PER_MINUTE } from '../../core/wire.ts';
import { type ServerOAuth, TRANSPORT_SSE } from '../shapes.ts';
import {
  ServerLoginProvider,
  type ServerLoginStore,
  ServerLogins,
  type StoredServerLogin,
  sameOrigin,
} from './provider.ts';

const { maxClientFieldLength } = SERVER_LOGIN_DEFAULTS;

/** Where a server's login stands, as the UI reads it. Holds no token and no secret. */
export interface ServerLoginStatus {
  /** Whether the router holds an access token that works, or a refresh token to renew it with. */
  signedIn: boolean;
  /** When the access token runs out, ISO. null when the server did not say. */
  expiresAt: string | null;
  /** Whether the router has a client at the server's login, typed by hand or registered. */
  clientRegistered: boolean;
  /** Whether a secret is stored for the hand-typed client. */
  hasClientSecret: boolean;
  /** The hand-typed scopes the router asks for when the server names none. null when none were typed. */
  scope: string | null;
}

/** A client typed by hand, for a login that only knows clients it was told about. Write-only: never served. */
export const serverLoginClientSchema = z.object({
  clientId: z.string().trim().min(1, 'A client id is required.').max(maxClientFieldLength),
  /** Absent keeps the stored secret while the client id stays the same. null removes it. */
  clientSecret: z.string().min(1).max(maxClientFieldLength).nullable().optional(),
  /** Absent keeps the stored scope. null removes it. */
  scope: z.string().trim().min(1).max(maxClientFieldLength).nullable().optional(),
});
export type ServerLoginClient = z.infer<typeof serverLoginClientSchema>;

/** What starting a login answers. */
export interface StartedServerLogin {
  /** True when the stored login still worked, after a refresh, so there is nothing to open. */
  signedIn: boolean;
  /** The server's login page, for the UI to open in a popup. null when `signedIn`. */
  authorizationUrl: string | null;
}

/** Which server a login was for, once it finished or was abandoned. */
export interface FinishedServerLogin {
  serverId: string;
  serverName: string;
}

/** A login the UI started, waiting for the server's login page to send the browser back. */
interface PendingLogin extends FinishedServerLogin {
  /** The OAuth `state`: what the callback is matched by, and its CSRF check. */
  state: string;
  /** The PKCE verifier the authorization URL was built with. */
  codeVerifier: string;
  /** When it started, in ms since the epoch. */
  startedAtMs: number;
}

/** What the service is built from. */
export interface ServerLoginDeps {
  /** Where logins are kept. */
  store: ServerLoginStore;
  /**
   * What a login's own requests are made with: the first knock, discovery, registration, the code exchange.
   * @defaultValue the global `fetch`
   */
  fetch?: FetchLike;
}

/**
 * Works out where a stored login stands, without a token or secret in the answer.
 *
 * @param oauth - The stored login, null for none.
 * @param [nowMs] - The time to judge expiry at, in ms since the epoch.
 * @returns The status.
 */
export function serverLoginStatus(oauth: ServerOAuth | null, nowMs: number = Date.now()): ServerLoginStatus {
  const { tokens = {}, tokensSavedAt, clientId, clientSecret, clientInformation, scope } = oauth ?? {};
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : null;
  const savedAtMs = tokensSavedAt === undefined ? Number.NaN : Date.parse(tokensSavedAt);
  const expiresAtMs = expiresIn !== null && Number.isFinite(savedAtMs) ? savedAtMs + expiresIn * MS_PER_SECOND : null;
  const hasAccessToken = typeof tokens.access_token === 'string';
  const isRefreshable = typeof tokens.refresh_token === 'string';
  const isFresh = expiresAtMs === null || expiresAtMs > nowMs;
  return {
    signedIn: hasAccessToken && (isFresh || isRefreshable),
    expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
    clientRegistered: clientId !== undefined || clientInformation !== undefined,
    hasClientSecret: clientSecret !== undefined,
    scope: scope ?? null,
  };
}

/**
 * Sets, replaces or removes a server's hand-typed client.
 *
 * @param current - The stored login, `{}` for none.
 * @param client - The client. null removes the client id, its secret and the scope.
 * @returns The new login. A changed client or scope drops the tokens and the registered client, which belong to the
 * old one.
 */
export function applyServerLoginClient(current: ServerOAuth, client: ServerLoginClient | null): ServerOAuth {
  const { clientId, clientSecret, scope, ...rest } = current;
  let next: ServerOAuth = rest;
  if (client !== null) {
    const isSameClient = client.clientId === clientId;
    const keptSecret = isSameClient ? clientSecret : undefined;
    const secret = client.clientSecret === undefined ? keptSecret : (client.clientSecret ?? undefined);
    const nextScope = client.scope === undefined ? scope : (client.scope ?? undefined);
    next = {
      ...rest,
      clientId: client.clientId,
      ...(secret === undefined ? {} : { clientSecret: secret }),
      ...(nextScope === undefined ? {} : { scope: nextScope }),
    };
  }
  const isChanged = clientId !== next.clientId || clientSecret !== next.clientSecret || scope !== next.scope;
  if (isChanged) {
    const { tokens: _tokens, tokensSavedAt: _savedAt, clientInformation: _registered, ...kept } = next;
    return kept;
  }
  return next;
}

/**
 * Drops a server's login when its address moves to another origin.
 *
 * @param previousUrl - The address in force.
 * @param nextUrl - The address about to replace it.
 * @param oauth - The stored login, null for none.
 * @returns The login to keep: without the tokens and registered client when the origin changed, null when nothing is
 * left.
 *
 * @remarks
 * A token is the old server's. Sending it to whatever the address now points at would hand it to a stranger.
 */
export function dropLoginOnMove(previousUrl: string, nextUrl: string, oauth: ServerOAuth | null): ServerOAuth | null {
  if (oauth === null || sameOrigin(previousUrl, nextUrl)) {
    return oauth;
  }
  const { tokens: _tokens, tokensSavedAt: _savedAt, clientInformation: _client, redirectUri: _uri, ...kept } = oauth;
  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * Server login: the OAuth sign-in a remote MCP server asks for, done once from the UI and kept for every instance of
 * the server.
 *
 * @remarks
 * Tokens and clients live in the store. What only lasts a login (its `state` and PKCE verifier) and what is cheap to
 * redo (discovery) stay in memory, so a restart drops logins in progress and nothing else.
 */
export class ServerLoginService {
  private readonly logins: ServerLogins;
  private readonly fetchFn: FetchLike;
  private readonly settings: ServerLoginSettings;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingLogin>();

  /**
   * Builds the service. Nothing starts.
   *
   * @param deps - The store, and how a login's requests are made.
   * @param [overrides] - Settings to change from `SERVER_LOGIN_DEFAULTS`.
   * @param [now] - The clock, in ms since the epoch.
   */
  constructor(deps: ServerLoginDeps, overrides: Partial<ServerLoginSettings> = {}, now: () => number = Date.now) {
    this.logins = new ServerLogins(deps.store, now);
    this.fetchFn = deps.fetch ?? fetch;
    this.settings = { ...SERVER_LOGIN_DEFAULTS, ...overrides };
    this.now = now;
  }

  /**
   * The provider an instance's HTTP transport, streamable or SSE, signs its requests with (`authProvider`).
   *
   * @param serverId - The server. A workspace instance passes its server's id.
   * @param instanceUrl - The address the instance connects to. At another origin than the server's, no token is sent.
   * @returns A provider that reads the stored login on every request, refreshes an expired token and saves the new
   * one. It fails a connect that needs a person with `ServerLoginRequiredError`.
   */
  providerFor(serverId: string, instanceUrl: string): OAuthClientProvider {
    return new ServerLoginProvider(this.logins, serverId, { instanceUrl });
  }

  /**
   * Reads where a server's login stands, for the UI.
   *
   * @param serverId - The server.
   * @returns The status, or null for an unknown or stdio server.
   */
  async status(serverId: string): Promise<ServerLoginStatus | null> {
    const stored = await this.logins.load(serverId);
    return stored === null ? null : serverLoginStatus(stored.oauth, this.now());
  }

  /**
   * Starts a login: asks the server which login it wants, and builds the URL of that login's page.
   *
   * @param serverId - A remote server.
   * @returns The page for the UI to open, or `signedIn` when the stored login still worked.
   * @throws NOT_FOUND for an unknown or stdio server, BAD_USER_INPUT for one that asks for no login, and
   * UPSTREAM_FAILED when its login cannot be reached or refuses the router.
   */
  async start(serverId: string): Promise<StartedServerLogin> {
    const server = await this.remote(serverId);
    const { resourceMetadataUrl, scope } = await this.challenge(server);
    this.prune();
    const state = randomBytes(this.settings.stateBytes).toString('base64url');
    const provider = new ServerLoginProvider(this.logins, serverId, { login: { state, codeVerifier: null } });
    let result: Awaited<ReturnType<typeof auth>>;
    try {
      result = await auth(provider, { serverUrl: server.url, resourceMetadataUrl, scope, fetchFn: this.timedFetch });
    } catch (cause) {
      throw upstreamFailed(`Could not start the login to server "${server.name}": ${errorMessage(cause)}`);
    }
    if (result === 'AUTHORIZED') {
      return { signedIn: true, authorizationUrl: null };
    }
    const authorizationUrl = provider.authorizationUrl();
    const codeVerifier = provider.savedCodeVerifier();
    if (authorizationUrl === null || codeVerifier === null) {
      throw upstreamFailed(`Server "${server.name}" asked for a login but the router could not build its URL.`);
    }
    this.pending.set(state, {
      state,
      codeVerifier,
      serverId,
      serverName: server.name,
      startedAtMs: this.now(),
    });
    return { signedIn: false, authorizationUrl };
  }

  /**
   * Finishes a login: swaps the code the server's login sent back for tokens, and saves them.
   *
   * @param state - The `state` the login echoed. It must name a login this process started, not yet expired or used.
   * @param code - The authorization code.
   * @returns Which server signed in.
   * @throws BAD_USER_INPUT for an unknown, used or expired `state`, NOT_FOUND when the server was deleted meanwhile,
   * and UPSTREAM_FAILED when the exchange fails.
   */
  async finish(state: string, code: string): Promise<FinishedServerLogin> {
    const login = this.take(state);
    const server = await this.remote(login.serverId);
    const provider = new ServerLoginProvider(this.logins, login.serverId, {
      login: { state, codeVerifier: login.codeVerifier },
    });
    try {
      await auth(provider, { serverUrl: server.url, authorizationCode: code, fetchFn: this.timedFetch });
    } catch (cause) {
      throw upstreamFailed(`Signing in to server "${server.name}" failed: ${errorMessage(cause)}`);
    }
    return { serverId: login.serverId, serverName: server.name };
  }

  /**
   * Ends a login the server's login refused: the person cancelled, or it rejected the client.
   *
   * @param state - The login's `state`.
   * @returns Which server it was for, or null for a `state` this process does not know.
   */
  abandon(state: string): FinishedServerLogin | null {
    const login = this.pending.get(state);
    this.pending.delete(state);
    return login === undefined ? null : { serverId: login.serverId, serverName: login.serverName };
  }

  /**
   * Signs a server out: forgets its tokens and registered client, and keeps a hand-typed client and scope.
   *
   * @param serverId - The server.
   * @returns Once the store has the change.
   * @throws NOT_FOUND for an unknown or stdio server.
   */
  async signOut(serverId: string): Promise<void> {
    await this.remote(serverId);
    this.forget(serverId);
    await this.logins.update(
      serverId,
      ({ tokens: _tokens, tokensSavedAt: _savedAt, clientInformation: _client, redirectUri: _uri, ...kept }) => kept,
    );
  }

  /**
   * Sets, replaces or removes a server's hand-typed client. Write-only: the status says only whether one is set.
   *
   * @param serverId - The server.
   * @param client - The client, untrusted. null removes the client id, its secret and the scope.
   * @returns Once the store has the change.
   * @throws NOT_FOUND for an unknown or stdio server, and BAD_USER_INPUT for a client that does not parse.
   */
  async setClient(serverId: string, client: ServerLoginClient | null): Promise<void> {
    const parsed = client === null ? null : parseOrThrow(serverLoginClientSchema, client);
    await this.remote(serverId);
    this.forget(serverId);
    await this.logins.update(serverId, (current) => applyServerLoginClient(current, parsed));
  }

  /**
   * Forgets what is held in memory for a server: logins in progress, and discovery.
   *
   * @param serverId - A server that was deleted, signed out or given a new address.
   */
  forget(serverId: string): void {
    this.logins.saveDiscovery(serverId, undefined);
    for (const [state, login] of this.pending) {
      if (login.serverId === serverId) {
        this.pending.delete(state);
      }
    }
  }

  /**
   * Makes a login's request, giving up after `requestTimeoutMs`.
   *
   * @param url - Where.
   * @param [init] - The request. Its own signal still aborts it.
   * @returns The response.
   */
  private readonly timedFetch: FetchLike = (url, init) => {
    const timeout = AbortSignal.timeout(this.settings.requestTimeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return this.fetchFn(url, { ...init, signal });
  };

  /**
   * Takes the pending login a callback names, so a `state` works once.
   *
   * @param state - From the callback.
   * @returns The login.
   * @throws BAD_USER_INPUT when there is none, or it is older than `pendingLoginTtlMinutes`.
   */
  private take(state: string): PendingLogin {
    const login = this.pending.get(state);
    this.pending.delete(state);
    if (login === undefined || this.isExpired(login)) {
      throw badInput('This login has expired or was already used. Start it again from the router.');
    }
    return login;
  }

  /**
   * Whether a pending login is too old to finish.
   *
   * @param login - The login.
   * @returns true once `pendingLoginTtlMinutes` have passed since it started.
   */
  private isExpired(login: PendingLogin): boolean {
    const ttlMs = this.settings.pendingLoginTtlMinutes * SECONDS_PER_MINUTE * MS_PER_SECOND;
    return this.now() - login.startedAtMs > ttlMs;
  }

  /** Drops the logins nobody finished. */
  private prune(): void {
    for (const [state, login] of this.pending) {
      if (this.isExpired(login)) {
        this.pending.delete(state);
      }
    }
  }

  /**
   * Reads a server that can have a login at all.
   *
   * @param serverId - The server.
   * @returns Its name, address and login.
   * @throws NOT_FOUND for an unknown or stdio server.
   */
  private async remote(serverId: string): Promise<StoredServerLogin> {
    const server = await this.logins.load(serverId);
    if (server === null) {
      throw notFound(`No remote server has the id "${serverId}".`);
    }
    return server;
  }

  /**
   * Knocks on a server without a token, for the login it names in its 401.
   *
   * @param server - The server.
   * @returns The `WWW-Authenticate` hints: where its resource metadata is, and which scopes it wants.
   * @throws BAD_USER_INPUT when it answers without asking for a login, and UPSTREAM_FAILED when it cannot be reached.
   */
  private async challenge(server: StoredServerLogin): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
    let response: Response;
    try {
      response = await this.knock(server);
    } catch (cause) {
      throw upstreamFailed(`Could not reach server "${server.name}": ${errorMessage(cause)}`);
    }
    const isChallenge = response.status === HttpStatus.Unauthorized;
    if (isChallenge === false) {
      throw badInput(`Server "${server.name}" did not ask for a login: it answered ${response.status} without one.`);
    }
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
    return { resourceMetadataUrl, scope };
  }

  /**
   * Sends a server an `initialize` with no token, or opens an SSE server's event stream, and reads only the status and
   * headers.
   *
   * @param server - The server: its address and transport, and the headers its instances send, since one may want a
   * header before it answers 401.
   * @returns The response, its body already discarded.
   */
  private async knock(server: StoredServerLogin): Promise<Response> {
    if (server.transport === TRANSPORT_SSE) {
      // An SSE server takes messages only on the session its stream opens, so the stream is what asks for a login.
      const response = await this.timedFetch(server.url, {
        method: 'GET',
        headers: { ...server.headers, accept: 'text/event-stream' },
      });
      await response.body?.cancel().catch(() => undefined);
      return response;
    }
    const response = await this.timedFetch(server.url, {
      method: 'POST',
      headers: { ...server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: this.settings.clientName, version: version() },
        },
      }),
    });
    await response.body?.cancel().catch(() => undefined);
    return response;
  }
}
