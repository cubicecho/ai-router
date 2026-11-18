import { createHash, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SERVER_LOGIN_DEFAULTS } from '../../../server/core/defaults.ts';
import { ErrorCode } from '../../../server/core/errors.ts';
import { HttpStatus, MS_PER_SECOND, SECONDS_PER_MINUTE } from '../../../server/core/wire.ts';
import {
  SERVER_LOGIN_CALLBACK_PATH,
  SERVER_LOGIN_METADATA_PATH,
  ServerLoginRequiredError,
  type ServerLoginStore,
  type StoredServerLogin,
} from '../../../server/tools/oauth/provider.ts';
import {
  createServerLoginRoutes,
  SERVER_LOGIN_MESSAGE_TYPE,
  serverLoginPage,
} from '../../../server/tools/oauth/routes.ts';
import {
  applyServerLoginClient,
  dropLoginOnMove,
  ServerLoginService,
  serverLoginStatus,
} from '../../../server/tools/oauth/service.ts';
import type { ServerOAuth } from '../../../server/tools/shapes.ts';
import { portOf } from '../../helpers.ts';

// Server login against a stand-in for an OAuth-protected MCP server on loopback: the protected
// resource at /mcp and its own authorization server at the root, with dynamic registration, or
// taking metadata URLs as client ids the way Home Assistant does.

const ROUTER_URL = 'http://router.test';
const UI_URL = 'http://ui.test';
const SERVER_ID = 'srv-1';
const EXPIRES_IN_SECONDS = 3600;

/** How the stand-in's authorization server takes clients. */
type ClientMode = 'register' | 'metadata-url';

/** The stand-in, and what it has seen. */
interface Upstream {
  origin: string;
  url: string;
  /** Access tokens /mcp lets through. */
  valid: Set<string>;
  registrations: Record<string, unknown>[];
  tokenRequests: Record<string, string>[];
  /** A value /mcp wants in `x-gate` before it answers at all, as a proxy in front of a server might. */
  gate: string | null;
  /** The paths a request carrying `x-gate` was sent to. */
  gatedPaths: string[];
  /** Plays the person at the login page: a code for what the router asked. */
  authorize(authorizationUrl: string): { code: string; state: string; params: URLSearchParams };
  close(): Promise<void>;
}

/**
 * Starts the stand-in on a port of its own.
 *
 * @param mode - How it takes clients.
 * @returns It, letting no token through yet.
 */
async function startUpstream(mode: ClientMode): Promise<Upstream> {
  const app = express();
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const origin = `http://127.0.0.1:${portOf(server)}`;
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  let issued = 0;
  const upstream: Upstream = {
    origin,
    url: `${origin}/mcp`,
    valid: new Set(),
    registrations: [],
    tokenRequests: [],
    gate: null,
    gatedPaths: [],
    authorize(authorizationUrl) {
      const params = new URL(authorizationUrl).searchParams;
      const code = randomUUID();
      codes.set(code, {
        challenge: params.get('code_challenge') ?? '',
        redirectUri: params.get('redirect_uri') ?? '',
        clientId: params.get('client_id') ?? '',
      });
      return { code, state: params.get('state') ?? '', params };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  app.use((req, _res, next) => {
    if (req.headers['x-gate'] !== undefined) {
      upstream.gatedPaths.push(req.path);
    }
    next();
  });
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
    res.json({ resource: upstream.url, authorization_servers: [origin] });
  });
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      ...(mode === 'register'
        ? { registration_endpoint: `${origin}/register` }
        : { client_id_metadata_document_supported: true }),
    });
  });
  app.post('/register', express.json(), (req, res) => {
    upstream.registrations.push(req.body);
    res.status(201).json({ ...req.body, client_id: 'registered-1', client_secret: 'planted-registered-secret' });
  });
  app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    const form: Record<string, string> = req.body;
    upstream.tokenRequests.push(form);
    if (form.grant_type === 'refresh_token' && form.refresh_token === 'planted-refresh-token') {
      issued += 1;
      const access = `refreshed-access-${issued}`;
      upstream.valid.add(access);
      // No refresh token: keep using the one you have.
      res.json({ access_token: access, token_type: 'Bearer', expires_in: EXPIRES_IN_SECONDS });
      return;
    }
    const grant = codes.get(form.code ?? '');
    codes.delete(form.code ?? '');
    const challenge = createHash('sha256')
      .update(form.code_verifier ?? '')
      .digest('base64url');
    const isValid =
      form.grant_type === 'authorization_code' &&
      grant !== undefined &&
      grant.challenge === challenge &&
      grant.redirectUri === form.redirect_uri &&
      grant.clientId === form.client_id;
    if (isValid === false) {
      res.status(HttpStatus.BadRequest).json({ error: 'invalid_grant' });
      return;
    }
    upstream.valid.add('planted-access-token');
    res.json({
      access_token: 'planted-access-token',
      token_type: 'Bearer',
      expires_in: EXPIRES_IN_SECONDS,
      refresh_token: 'planted-refresh-token',
    });
  });
  app.post('/mcp', express.json(), async (req, res) => {
    if (upstream.gate !== null && req.headers['x-gate'] !== upstream.gate) {
      res.status(HttpStatus.Forbidden).end();
      return;
    }
    const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (upstream.valid.has(bearer) === false) {
      res
        .status(HttpStatus.Unauthorized)
        .set('www-authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`)
        .end();
      return;
    }
    const mcp = new McpServer({ name: 'protected', version: '1.0.0' });
    mcp.registerTool('hello', { description: 'Says hello.' }, () => ({ content: [{ type: 'text', text: 'hi' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  return upstream;
}

/**
 * An in-memory store, holding one remote server.
 *
 * @param url - The server's address.
 * @param [oauth] - Its login to start with.
 * @returns The store, and the row it keeps.
 */
function memoryStore(url: string, oauth: ServerOAuth | null = null): ServerLoginStore & { row: StoredServerLogin } {
  const row: StoredServerLogin = { name: 'protected', url, oauth, headers: {} };
  return {
    row,
    async load(serverId) {
      // A copy, as a database would hand back.
      return serverId === SERVER_ID ? structuredClone(row) : null;
    },
    async save(serverId, next) {
      if (serverId === SERVER_ID) {
        row.oauth = next === null ? null : structuredClone(next);
      }
    },
  };
}

/** The router's two endpoints, listening on loopback. */
interface RouterEndpoints {
  origin: string;
  close(): Promise<void>;
}

/**
 * Serves the server-login routes on a port of their own.
 *
 * @param service - Server login.
 * @returns Where they answer.
 */
async function startRoutes(service: ServerLoginService): Promise<RouterEndpoints> {
  const app = express();
  app.use(createServerLoginRoutes(service));
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    origin: `http://127.0.0.1:${portOf(server)}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Connects an instance's MCP client the way `tools/instance` would, with the service's provider.
 *
 * @param service - Server login.
 * @param url - The address the instance connects to.
 * @returns The connected client.
 */
async function connectInstance(service: ServerLoginService, url: string): Promise<Client> {
  const client = new Client({ name: 'instance', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider: service.providerFor(SERVER_ID, url),
  });
  await client.connect(transport);
  return client;
}

let upstream: Upstream;
let routes: RouterEndpoints;

beforeEach(() => {
  vi.stubEnv('SERVER_URL', ROUTER_URL);
  vi.stubEnv('APP_URL', UI_URL);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  await routes?.close();
  await upstream?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * Starts the stand-in, a store for it, the service and its routes.
 *
 * @param mode - How the stand-in takes clients.
 * @param [now] - The service's clock.
 * @returns The store and the service.
 */
async function setUp(mode: ClientMode, now?: () => number) {
  upstream = await startUpstream(mode);
  const store = memoryStore(upstream.url);
  const service = new ServerLoginService({ store }, {}, now);
  routes = await startRoutes(service);
  return { store, service };
}

/**
 * Follows the callback the server's login would send the browser to.
 *
 * @param query - The query the login appends.
 * @returns The page's status and HTML.
 */
async function followCallback(query: Record<string, string>): Promise<{ status: number; html: string }> {
  const response = await fetch(`${routes.origin}${SERVER_LOGIN_CALLBACK_PATH}?${new URLSearchParams(query)}`);
  return { status: response.status, html: await response.text() };
}

/**
 * Starts a login, plays the person at the login page and follows the callback.
 *
 * @param service - Server login.
 * @returns The callback page.
 */
async function signIn(service: ServerLoginService): Promise<{ status: number; html: string }> {
  const { authorizationUrl } = await service.start(SERVER_ID);
  const { code, state } = upstream.authorize(authorizationUrl ?? '');
  return followCallback({ code, state });
}

describe('server login', () => {
  it('registers a client dynamically, at the router redirect URI', async () => {
    const { store, service } = await setUp('register');

    const started = await service.start(SERVER_ID);

    expect(started.signedIn).toBe(false);
    const params = new URL(started.authorizationUrl ?? '').searchParams;
    expect(params.get('client_id')).toBe('registered-1');
    expect(params.get('redirect_uri')).toBe(`${ROUTER_URL}${SERVER_LOGIN_CALLBACK_PATH}`);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('resource')).toBe(upstream.url);
    expect(upstream.registrations).toEqual([
      expect.objectContaining({
        client_name: SERVER_LOGIN_DEFAULTS.clientName,
        redirect_uris: [`${ROUTER_URL}${SERVER_LOGIN_CALLBACK_PATH}`],
      }),
    ]);
    expect(store.row.oauth).toMatchObject({
      clientInformation: { client_id: 'registered-1' },
      redirectUri: `${ROUTER_URL}${SERVER_LOGIN_CALLBACK_PATH}`,
    });
  });

  it('starts, comes back through the callback, and saves the tokens', async () => {
    const { store, service } = await setUp('register');

    const page = await signIn(service);

    expect(page.status).toBe(HttpStatus.Ok);
    expect(page.html).toContain('postMessage');
    expect(page.html).toContain(`"${UI_URL}"`);
    expect(page.html).toContain(`"type":"${SERVER_LOGIN_MESSAGE_TYPE}"`);
    expect(page.html).toContain('window.close()');
    expect(page.html).not.toContain('planted');
    expect(store.row.oauth?.tokens).toMatchObject({
      access_token: 'planted-access-token',
      refresh_token: 'planted-refresh-token',
    });
    expect(await service.status(SERVER_ID)).toMatchObject({ signedIn: true, clientRegistered: true });

    const instance = await connectInstance(service, upstream.url);
    const { tools } = await instance.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['hello']);
    await instance.close();
  });

  it('takes the router metadata URL as its client id where the login supports it, even over HTTP', async () => {
    const { store, service } = await setUp('metadata-url');

    const page = await signIn(service);

    expect(page.status).toBe(HttpStatus.Ok);
    expect(upstream.registrations).toEqual([]);
    expect(upstream.tokenRequests.at(-1)?.client_id).toBe(`${ROUTER_URL}${SERVER_LOGIN_METADATA_PATH}`);
    expect(store.row.oauth?.tokens).toMatchObject({ access_token: 'planted-access-token' });
  });

  it('refreshes an expired access token for an instance, and saves the new one', async () => {
    const { store, service } = await setUp('register');
    await signIn(service);
    upstream.valid.delete('planted-access-token');

    const instance = await connectInstance(service, upstream.url);

    expect(upstream.tokenRequests.at(-1)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'planted-refresh-token',
    });
    expect(store.row.oauth?.tokens).toMatchObject({
      access_token: 'refreshed-access-1',
      refresh_token: 'planted-refresh-token',
    });
    expect((await instance.listTools()).tools).toHaveLength(1);
    await instance.close();
  });

  it('fails an instance connect that needs a person to sign in', async () => {
    const { service } = await setUp('register');

    await expect(connectInstance(service, upstream.url)).rejects.toBeInstanceOf(ServerLoginRequiredError);
  });

  it('sends no token to an instance whose address moved to another origin', async () => {
    const { service } = await setUp('register');
    await signIn(service);

    const elsewhere = service.providerFor(SERVER_ID, 'http://elsewhere.test/mcp');

    expect(await elsewhere.tokens()).toBeUndefined();
    expect(await service.providerFor(SERVER_ID, upstream.url).tokens()).toMatchObject({
      access_token: 'planted-access-token',
    });
  });

  it('refuses a forged state, and a state used twice', async () => {
    const { service } = await setUp('register');
    const { authorizationUrl } = await service.start(SERVER_ID);
    const { code, state } = upstream.authorize(authorizationUrl ?? '');

    const forged = await followCallback({ code, state: 'forged' });
    const first = await followCallback({ code, state });
    const second = await followCallback({ code, state });

    expect(forged.status).toBe(HttpStatus.BadRequest);
    expect(forged.html).toContain('expired or was already used');
    expect(first.status).toBe(HttpStatus.Ok);
    expect(second.status).toBe(HttpStatus.BadRequest);
  });

  it('refuses a state past its time to live', async () => {
    let nowMs = Date.parse('2026-11-18T00:00:00Z');
    const { store, service } = await setUp('register', () => nowMs);
    const { authorizationUrl } = await service.start(SERVER_ID);
    const { code, state } = upstream.authorize(authorizationUrl ?? '');
    nowMs += SERVER_LOGIN_DEFAULTS.pendingLoginTtlMinutes * SECONDS_PER_MINUTE * MS_PER_SECOND + 1;

    await expect(service.finish(state, code)).rejects.toMatchObject({
      extensions: { code: ErrorCode.BadUserInput },
    });
    expect(store.row.oauth?.tokens).toBeUndefined();
  });

  it('reports a login the person cancelled to the window that opened it', async () => {
    const { store, service } = await setUp('register');
    const { authorizationUrl } = await service.start(SERVER_ID);
    const { state } = upstream.authorize(authorizationUrl ?? '');

    const page = await followCallback({ state, error: 'access_denied' });

    expect(page.status).toBe(HttpStatus.BadRequest);
    expect(page.html).toContain('access_denied');
    expect(page.html).toContain(`"serverId":"${SERVER_ID}"`);
    expect(page.html).toContain('"ok":false');
    expect(page.html).not.toContain('window.close()');
    expect(store.row.oauth?.tokens).toBeUndefined();
  });

  it('signs out, forgetting the tokens and keeping a hand-typed client', async () => {
    upstream = await startUpstream('register');
    const store = memoryStore(upstream.url, {
      clientId: 'typed-client',
      clientSecret: 'planted-client-secret',
      scope: 'read',
    });
    const service = new ServerLoginService({ store });
    routes = await startRoutes(service);
    const started = await service.start(SERVER_ID);
    expect(new URL(started.authorizationUrl ?? '').searchParams.get('client_id')).toBe('typed-client');
    expect(upstream.registrations).toEqual([]);
    const { code, state } = upstream.authorize(started.authorizationUrl ?? '');
    await followCallback({ code, state });
    expect(store.row.oauth?.tokens).toBeDefined();

    await service.signOut(SERVER_ID);

    expect(store.row.oauth).toEqual({ clientId: 'typed-client', clientSecret: 'planted-client-secret', scope: 'read' });
    expect(await service.status(SERVER_ID)).toEqual({
      signedIn: false,
      expiresAt: null,
      clientRegistered: true,
      hasClientSecret: true,
      scope: 'read',
    });
  });

  it('answers a status that holds no token or secret', async () => {
    const { store, service } = await setUp('register');
    await signIn(service);
    await service.setClient(SERVER_ID, { clientId: 'typed-client', clientSecret: 'planted-client-secret' });
    await signIn(service);
    // Planted alongside, so every kind of stored secret is in the row being read.
    store.row.oauth = { ...store.row.oauth, clientInformation: { client_secret: 'planted-registered-secret' } };
    expect(JSON.stringify(store.row.oauth)).toContain('planted-access-token');
    expect(JSON.stringify(store.row.oauth)).toContain('planted-refresh-token');

    const status = await service.status(SERVER_ID);
    const metadata = await (await fetch(`${routes.origin}${SERVER_LOGIN_METADATA_PATH}`)).text();

    expect(status).toMatchObject({ signedIn: true, hasClientSecret: true });
    for (const answer of [JSON.stringify(status), metadata]) {
      expect(answer).not.toContain('planted');
      expect(answer).not.toContain('typed-client');
    }
  });

  it('dates the access token from when it was saved', async () => {
    const savedAt = '2026-11-18T00:00:00.000Z';
    const oauth: ServerOAuth = {
      tokens: { access_token: 'a', expires_in: EXPIRES_IN_SECONDS },
      tokensSavedAt: savedAt,
    };
    const expiresAtMs = Date.parse(savedAt) + EXPIRES_IN_SECONDS * MS_PER_SECOND;

    expect(serverLoginStatus(oauth, expiresAtMs - 1)).toMatchObject({
      signedIn: true,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    expect(serverLoginStatus(oauth, expiresAtMs + 1).signedIn).toBe(false);
    expect(
      serverLoginStatus({ ...oauth, tokens: { ...oauth.tokens, refresh_token: 'r' } }, expiresAtMs + 1),
    ).toMatchObject({ signedIn: true });
    expect(serverLoginStatus(null)).toEqual({
      signedIn: false,
      expiresAt: null,
      clientRegistered: false,
      hasClientSecret: false,
      scope: null,
    });
  });

  it("knocks with the server's headers, and sends none of them to its login", async () => {
    const { store, service } = await setUp('register');
    upstream.gate = 'planted-gate';
    store.row.headers = { 'x-gate': 'planted-gate' };

    const started = await service.start(SERVER_ID);

    expect(started.authorizationUrl).toBeTruthy();
    expect(upstream.gatedPaths).toEqual(['/mcp']);
  });

  it('refuses to start a login for a server that does not ask for one', async () => {
    upstream = await startUpstream('register');
    const service = new ServerLoginService({ store: memoryStore(`${upstream.origin}/nothing`) });
    routes = await startRoutes(service);

    await expect(service.start(SERVER_ID)).rejects.toMatchObject({ extensions: { code: ErrorCode.BadUserInput } });
    await expect(service.start('no-such-server')).rejects.toMatchObject({ extensions: { code: ErrorCode.NotFound } });
  });

  it('serves the router client metadata at its client id', async () => {
    await setUp('register');

    const response = await fetch(`${routes.origin}${SERVER_LOGIN_METADATA_PATH}`);

    expect(response.status).toBe(HttpStatus.Ok);
    expect(await response.json()).toMatchObject({
      client_id: `${ROUTER_URL}${SERVER_LOGIN_METADATA_PATH}`,
      client_uri: UI_URL,
      redirect_uris: [`${ROUTER_URL}${SERVER_LOGIN_CALLBACK_PATH}`],
      token_endpoint_auth_method: 'none',
    });
  });
});

describe('the callback page', () => {
  it('escapes what the login sent back', async () => {
    const { service } = await setUp('register');
    const attack = '</script><img src=x onerror="alert(1)">';

    const page = await followCallback({ state: 'whatever', error: 'x', error_description: attack });

    expect(page.status).toBe(HttpStatus.BadRequest);
    expect(page.html).not.toContain('<img');
    // Only the page's own script element closes.
    expect(page.html.split('</script>')).toHaveLength(2);
    expect(page.html).toContain('&lt;/script&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(page.html).toContain('\\u003c/script\\u003e\\u003cimg');
    expect(service.abandon('whatever')).toBeNull();
  });

  it('escapes a server name in the text and in the script', () => {
    const html = serverLoginPage(
      {
        type: SERVER_LOGIN_MESSAGE_TYPE,
        serverId: 'id',
        serverName: '<b>"evil"</b>',
        ok: true,
        error: null,
      },
      'nonce"><script>',
    );

    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;&quot;evil&quot;&lt;/b&gt;');
    expect(html).toContain('\\u003cb\\u003e');
    expect(html).toContain('nonce="nonce&quot;&gt;&lt;script&gt;"');
  });
});

describe('applyServerLoginClient', () => {
  const signedIn: ServerOAuth = {
    clientId: 'a',
    clientSecret: 's',
    tokens: { access_token: 't' },
    clientInformation: { client_id: 'registered' },
    redirectUri: `${ROUTER_URL}${SERVER_LOGIN_CALLBACK_PATH}`,
  };

  it('keeps the tokens for the same client, and the secret when none is sent', () => {
    expect(applyServerLoginClient(signedIn, { clientId: 'a' })).toEqual(signedIn);
  });

  it('drops the tokens, the registered client and the old secret for another client', () => {
    expect(applyServerLoginClient(signedIn, { clientId: 'b' })).toEqual({
      clientId: 'b',
      redirectUri: signedIn.redirectUri,
    });
  });

  it('removes the secret on null, and the whole client on a null client', () => {
    expect(applyServerLoginClient({ clientId: 'a', clientSecret: 's' }, { clientId: 'a', clientSecret: null })).toEqual(
      { clientId: 'a' },
    );
    expect(applyServerLoginClient({ clientId: 'a', scope: 'read' }, null)).toEqual({});
  });
});

describe('dropLoginOnMove', () => {
  const oauth: ServerOAuth = { clientId: 'kept', tokens: { access_token: 't' }, clientInformation: { client_id: 'r' } };

  it('forgets the tokens and registered client when the address moves to another origin', () => {
    expect(dropLoginOnMove('https://a.test/mcp', 'https://b.test/mcp', oauth)).toEqual({ clientId: 'kept' });
  });

  it('keeps them for a new path on the same origin', () => {
    expect(dropLoginOnMove('https://a.test/mcp', 'https://a.test/v2/mcp', oauth)).toEqual(oauth);
  });
});
