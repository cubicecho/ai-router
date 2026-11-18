import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { isHttpsUrl } from '@modelcontextprotocol/sdk/client/auth.js';
import {
  type OAuthClientInformationMixed,
  OAuthClientInformationSchema,
  type OAuthClientMetadata,
  type OAuthTokens,
  OAuthTokensSchema,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { serverUrl } from '../../core/config.ts';
import { SERVER_LOGIN_DEFAULTS } from '../../core/defaults.ts';
import type { ServerOAuth } from '../shapes.ts';

/** Where a server's login sends the browser back to, under the router's address. */
export const SERVER_LOGIN_CALLBACK_PATH = '/oauth/callback';
/** Where the router's client metadata document is served, under its address. It doubles as a client id. */
export const SERVER_LOGIN_METADATA_PATH = '/oauth/client-metadata.json';

/** A remote server as server login reads it. */
export interface StoredServerLogin {
  name: string;
  /** The server's streamable-HTTP address. */
  url: string;
  /** Its login as stored, null when it has none. */
  oauth: ServerOAuth | null;
}

/** Where server logins are kept: the `servers.oauth` column, which is never served. */
export interface ServerLoginStore {
  /**
   * Reads one server's login.
   *
   * @param serverId - The server.
   * @returns null for an unknown server, or one not reached over streamable HTTP.
   */
  load(serverId: string): Promise<StoredServerLogin | null>;
  /**
   * Replaces one server's login.
   *
   * @param serverId - The server.
   * @param oauth - The whole login. null clears the column.
   */
  save(serverId: string, oauth: ServerOAuth | null): Promise<void>;
}

/** Thrown into a connect that needs a person to sign in, which nobody can do from a background connect. */
export class ServerLoginRequiredError extends Error {
  /**
   * Names the server.
   *
   * @param serverName - The server that wants the login.
   */
  constructor(serverName: string) {
    super(`Server "${serverName}" needs someone to sign in to it from the router's UI.`);
    this.name = 'ServerLoginRequiredError';
  }
}

/**
 * The router's redirect URI.
 *
 * @returns `<serverUrl>/oauth/callback`.
 */
export function callbackUrl(): string {
  return `${serverUrl()}${SERVER_LOGIN_CALLBACK_PATH}`;
}

/**
 * The router's client metadata document URL, which is its client id at a login that takes one.
 *
 * @returns `<serverUrl>/oauth/client-metadata.json`.
 */
export function clientMetadataUrl(): string {
  return `${serverUrl()}${SERVER_LOGIN_METADATA_PATH}`;
}

/**
 * The client metadata the router registers with, and serves at its metadata URL.
 *
 * @param [options.scope] - Scopes to ask for when the server names none.
 * @param [options.confidential] - Whether it authenticates with a client secret.
 * @returns RFC 7591 client metadata, with `callbackUrl()` its one redirect URI.
 */
export function routerClientMetadata(options: { scope?: string; confidential?: boolean } = {}): OAuthClientMetadata {
  const { scope, confidential = false } = options;
  return {
    client_name: SERVER_LOGIN_DEFAULTS.clientName,
    redirect_uris: [callbackUrl()],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: confidential ? 'client_secret_post' : 'none',
    ...(scope === undefined ? {} : { scope }),
  };
}

/**
 * The router's server logins: the store, changed one write at a time per server, and discovery, kept in memory.
 *
 * @remarks
 * Every write is a read-modify-write of the whole column, so a refresh racing a sign-out would otherwise lose one of
 * them. Discovery is cheap to redo and not worth a write.
 */
export class ServerLogins {
  private readonly store: ServerLoginStore;
  private readonly discoveryByServer = new Map<string, OAuthDiscoveryState>();
  private readonly writes = new Map<string, Promise<void>>();
  /** The clock tokens are dated by. */
  readonly now: () => number;

  /**
   * Wraps a store.
   *
   * @param store - Where logins are kept.
   * @param [now] - The clock, in ms since the epoch.
   */
  constructor(store: ServerLoginStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  /**
   * Reads one server's login.
   *
   * @param serverId - The server.
   * @returns What the store holds, after any write to it still in flight. null for an unknown or stdio server.
   */
  async load(serverId: string): Promise<StoredServerLogin | null> {
    // A failed write was already reported to whoever made it.
    await this.writes.get(serverId)?.catch(() => undefined);
    return this.store.load(serverId);
  }

  /**
   * Changes one server's login, after any write to it still in flight.
   *
   * @param serverId - The server. Nothing is written when it no longer exists.
   * @param change - Makes the new login from the stored one, `{}` when there is none. An empty result clears it.
   * @returns Once the store has saved it.
   */
  update(serverId: string, change: (current: ServerOAuth) => ServerOAuth): Promise<void> {
    const previous = this.writes.get(serverId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const stored = await this.store.load(serverId);
        if (stored === null) {
          return;
        }
        const oauth = change(stored.oauth ?? {});
        await this.store.save(serverId, Object.keys(oauth).length > 0 ? oauth : null);
      });
    this.writes.set(serverId, next);
    return next;
  }

  /**
   * Reads what discovery found for a server.
   *
   * @param serverId - The server.
   * @returns The SDK's discovery state, or undefined when none is kept.
   */
  discovery(serverId: string): OAuthDiscoveryState | undefined {
    return this.discoveryByServer.get(serverId);
  }

  /**
   * Keeps or forgets what discovery found for a server.
   *
   * @param serverId - The server.
   * @param state - The SDK's discovery state. undefined forgets it.
   */
  saveDiscovery(serverId: string, state: OAuthDiscoveryState | undefined): void {
    if (state === undefined) {
      this.discoveryByServer.delete(serverId);
      return;
    }
    this.discoveryByServer.set(serverId, state);
  }
}

/** The interactive half of a login: what a provider started from the UI carries. */
export interface InteractiveLogin {
  /** The OAuth `state` the login is matched by. */
  state: string;
  /** The PKCE verifier, once the authorization URL was built. null before. */
  codeVerifier: string | null;
}

/** What a provider is made for. */
export interface ServerLoginProviderOptions {
  /** The login the UI started, for the provider that starts or finishes it. Left out for an instance's provider. */
  login?: InteractiveLogin;
  /** The address an instance connects to. Left out for a login, which goes to the stored address. */
  instanceUrl?: string;
}

/**
 * The SDK's `OAuthClientProvider` for one remote server, over its stored login.
 *
 * @remarks
 * With a login, it is the interactive half: it may register a client, builds the authorization URL, and swaps the
 * code. Without one it is what an instance's transport holds: it hands out the stored token and lets the SDK refresh
 * it, and fails the connect with {@link ServerLoginRequiredError} rather than start a login nobody will finish. It
 * reads the store every time, so a long-lived transport sees a login made after it was built.
 */
export class ServerLoginProvider implements OAuthClientProvider {
  private readonly logins: ServerLogins;
  private readonly serverId: string;
  private readonly login: InteractiveLogin | undefined;
  private readonly instanceUrl: string | undefined;
  /** The stored login as last read, for the getters the SDK calls without awaiting. */
  private last: ServerOAuth = {};
  /** The server's name as last read, for messages. */
  private serverName: string;
  private verifier: string | null;
  private loginPage: string | null = null;

  /**
   * Makes a provider for one server.
   *
   * @param logins - Where the login is kept.
   * @param serverId - The server. A workspace instance signs in as its server.
   * @param [options] - The interactive login, or the instance's address.
   */
  constructor(logins: ServerLogins, serverId: string, options: ServerLoginProviderOptions = {}) {
    this.logins = logins;
    this.serverId = serverId;
    this.login = options.login;
    this.instanceUrl = options.instanceUrl;
    this.serverName = serverId;
    this.verifier = options.login?.codeVerifier ?? null;
  }

  /**
   * The login page the SDK asked to send the browser to.
   *
   * @returns Its URL, or null when the SDK did not need one.
   */
  authorizationUrl(): string | null {
    return this.loginPage;
  }

  /**
   * The PKCE verifier the SDK saved while building the authorization URL.
   *
   * @returns It, or null before then.
   */
  savedCodeVerifier(): string | null {
    return this.verifier;
  }

  /**
   * Reads the stored login, and keeps it for the getters.
   *
   * @returns The login, or `{}` for none. An instance at another origin than the server's gets `{}` too.
   *
   * @remarks
   * A workspace may point an instance at another address. A token is the stored server's, so it never goes elsewhere.
   */
  private async read(): Promise<ServerOAuth> {
    const stored = await this.logins.load(this.serverId);
    const isOtherOrigin =
      stored !== null && this.instanceUrl !== undefined && sameOrigin(stored.url, this.instanceUrl) === false;
    this.serverName = stored?.name ?? this.serverId;
    this.last = stored === null || isOtherOrigin ? {} : (stored.oauth ?? {});
    return this.last;
  }

  /**
   * The redirect URI, which is always the router's.
   *
   * @returns `callbackUrl()`.
   */
  get redirectUrl(): string {
    return callbackUrl();
  }

  /**
   * The router's metadata URL as a client id, offered during a login over HTTPS only.
   *
   * @returns The URL, or undefined in the background or over plain HTTP, where the SDK refuses it.
   */
  get clientMetadataUrl(): string | undefined {
    const url = clientMetadataUrl();
    return this.login !== undefined && isHttpsUrl(url) ? url : undefined;
  }

  /**
   * The metadata a registration sends.
   *
   * @returns The router's client metadata, with the stored scope.
   */
  get clientMetadata(): OAuthClientMetadata {
    const { scope, clientSecret } = this.last;
    return routerClientMetadata({ scope, confidential: clientSecret !== undefined });
  }

  /**
   * The login's `state`.
   *
   * @returns It.
   * @throws {@link ServerLoginRequiredError} In the background, where the SDK asks for one only to start a login.
   */
  state(): string {
    if (this.login === undefined) {
      throw new ServerLoginRequiredError(this.serverName);
    }
    return this.login.state;
  }

  /**
   * The client to sign in as.
   *
   * @returns A hand-typed client, else a registered one set up with this redirect URI, else undefined so the SDK
   * registers one.
   * @throws {@link ServerLoginRequiredError} In the background with no client: registering one is a login's job.
   *
   * @remarks
   * A login that takes metadata URLs as ids (Home Assistant) is given the URL even over plain HTTP, which the SDK
   * refuses to do itself. The redirect URI shares its origin, which is what such a login checks.
   */
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const { clientId, clientSecret, clientInformation, redirectUri } = await this.read();
    if (clientId !== undefined) {
      return { client_id: clientId, ...(clientSecret === undefined ? {} : { client_secret: clientSecret }) };
    }
    const registered =
      redirectUri === callbackUrl() ? OAuthClientInformationSchema.safeParse(clientInformation) : undefined;
    if (registered?.success) {
      return registered.data;
    }
    if (this.login === undefined) {
      throw new ServerLoginRequiredError(this.serverName);
    }
    const metadataUrl = clientMetadataUrl();
    const takesMetadataUrls =
      this.logins.discovery(this.serverId)?.authorizationServerMetadata?.client_id_metadata_document_supported === true;
    if (takesMetadataUrls && isHttpsUrl(metadataUrl) === false) {
      const information = { client_id: metadataUrl };
      await this.saveClientInformation(information);
      return information;
    }
    return undefined;
  }

  /**
   * Keeps the client a registration made, with the redirect URI it was made for.
   *
   * @param information - What the login answered the registration with.
   * @returns Once it is stored.
   */
  async saveClientInformation(information: OAuthClientInformationMixed): Promise<void> {
    const redirectUri = callbackUrl();
    await this.logins.update(this.serverId, (current) => ({
      ...current,
      clientInformation: { ...information },
      redirectUri,
    }));
  }

  /**
   * The stored tokens.
   *
   * @returns They, or undefined when there are none or they no longer parse.
   */
  async tokens(): Promise<OAuthTokens | undefined> {
    const { tokens } = await this.read();
    const parsed = tokens === undefined ? undefined : OAuthTokensSchema.safeParse(tokens);
    return parsed?.success ? parsed.data : undefined;
  }

  /**
   * Keeps new tokens, from a code exchange or a refresh.
   *
   * @param tokens - The token response.
   * @returns Once they are stored.
   *
   * @remarks
   * A refresh may leave the refresh token out, which means keep using the one you have.
   */
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const redirectUri = callbackUrl();
    const savedAt = new Date(this.logins.now()).toISOString();
    await this.logins.update(this.serverId, (current) => {
      const refreshToken = tokens.refresh_token ?? current.tokens?.refresh_token;
      return {
        ...current,
        tokens: { ...tokens, ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }) },
        tokensSavedAt: savedAt,
        redirectUri,
      };
    });
  }

  /**
   * Keeps the login page for the UI to open.
   *
   * @param authorizationUrl - The login page.
   * @throws {@link ServerLoginRequiredError} In the background, where there is nobody to send there.
   */
  redirectToAuthorization(authorizationUrl: URL): void {
    if (this.login === undefined) {
      throw new ServerLoginRequiredError(this.serverName);
    }
    this.loginPage = authorizationUrl.toString();
  }

  /**
   * Keeps the PKCE verifier, which the service holds with the pending login.
   *
   * @param codeVerifier - The verifier.
   */
  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  /**
   * The PKCE verifier for the code exchange.
   *
   * @returns It.
   * @throws If no login is in progress.
   */
  codeVerifier(): string {
    if (this.verifier === null) {
      throw new Error(`No login to server "${this.serverName}" is in progress.`);
    }
    return this.verifier;
  }

  /**
   * Keeps what discovery found.
   *
   * @param state - The SDK's discovery state.
   */
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.logins.saveDiscovery(this.serverId, state);
  }

  /**
   * What discovery found last time.
   *
   * @returns The SDK's discovery state, or undefined.
   */
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.logins.discovery(this.serverId);
  }

  /**
   * Forgets what the server's login rejected, so the next attempt starts over from there.
   *
   * @param scope - What the SDK found invalid.
   * @returns Once the store has the change.
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'verifier') {
      this.verifier = null;
      return;
    }
    if (scope === 'all' || scope === 'discovery') {
      this.logins.saveDiscovery(this.serverId, undefined);
    }
    if (scope === 'discovery') {
      return;
    }
    const dropsClient = scope === 'all' || scope === 'client';
    await this.logins.update(this.serverId, (current) => {
      const { tokens: _tokens, tokensSavedAt: _savedAt, clientInformation, ...kept } = current;
      return dropsClient || clientInformation === undefined ? kept : { ...kept, clientInformation };
    });
  }
}

/**
 * Whether two addresses share an origin.
 *
 * @param a - An absolute URL.
 * @param b - Another.
 * @returns true when scheme, host and port match. false when either does not parse.
 */
export function sameOrigin(a: string, b: string): boolean {
  const isParsable = URL.canParse(a) && URL.canParse(b);
  return isParsable && new URL(a).origin === new URL(b).origin;
}
