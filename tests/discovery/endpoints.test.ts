import { IncomingMessage, type Server } from 'node:http';
import { Socket } from 'node:net';
import {
  AI_CATALOG_WELL_KNOWN_PATH,
  cardConnection,
  discover,
  hostSlug,
  parseAiCatalog,
  parseServerCard,
  SERVER_CARD_SCHEMA_URL,
} from '@cubicecho/mcp-discovery';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedAuthHost } from '../../server/auth/auth-host.ts';
import { version } from '../../server/core/config.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { AGENTS_MCP_PATH, discoveryEndpoints, mdnsInstanceName } from '../../server/discovery/endpoints.ts';
import { createApp } from '../../server/http/app.ts';
import { closeTestDb, createTestAuth, createTestDb, createWorkspaceWithKey, portOf, type TestDb } from '../helpers.ts';

// The router's discovery documents, served by the app production runs over a real socket: they answer before the
// agents door's key check, and name the endpoint and nothing behind it.

/** A workspace whose name must never show up in a public document. */
const WORKSPACE = 'secret-team';

let db: TestDb;
let server: Server;
let base: string;

beforeAll(async () => {
  db = await createTestDb();
  await createWorkspaceWithKey(db, WORKSPACE);
  const { app } = await createApp({ db, authHost: fixedAuthHost(createTestAuth(db)) });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${portOf(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb(db);
});

describe('discoveryEndpoints', () => {
  it('names the agents door after the host, and asks for a key without carrying one', async () => {
    const [endpoint] = discoveryEndpoints({ version: '1.2.3', host: 'NAS.lan' });
    const card = await endpoint.card({
      endpointUrl: 'http://nas:3000/mcp',
      request: new IncomingMessage(new Socket()),
    });
    expect(endpoint.path).toBe(AGENTS_MCP_PATH);
    expect(endpoint.identifier).toBe(`urn:air:${hostSlug('NAS.lan')}.ai-router:mcp:agents`);
    expect(card).toMatchObject({
      name: `io.github.cubicecho.ai-router.${hostSlug('NAS.lan')}/agents`,
      version: '1.2.3',
      title: 'AI Router on NAS.lan',
    });
    expect(card.remotes?.[0]?.headers).toEqual([expect.objectContaining({ name: 'Authorization', isRequired: true })]);
    expect(cardConnection(card)).toEqual({ url: 'http://nas:3000/mcp', requiredHeaders: ['Authorization'] });
    // An input with a `value` would carry the key itself.
    expect(card.remotes?.[0]?.headers?.[0]).not.toHaveProperty('value');
  });

  it('announces over mDNS under a name of its own host', () => {
    expect(mdnsInstanceName('nas')).toBe('AI Router on nas');
  });
});

describe('the discovery documents', () => {
  it('serve the AI Catalog to anyone, pointing at the agents door card', async () => {
    const url = `${base}${AI_CATALOG_WELL_KNOWN_PATH}`;
    const response = await fetch(url);
    expect(response.status).toBe(HttpStatus.Ok);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    const catalog = parseAiCatalog(await response.json(), url);
    expect(catalog.entries).toEqual([expect.objectContaining({ url: `${base}${AGENTS_MCP_PATH}/server-card` })]);
  });

  it('serve the agents door card before its key check, with the URL the client reached', async () => {
    const url = `${base}${AGENTS_MCP_PATH}/server-card`;
    const response = await fetch(url);
    expect(response.status).toBe(HttpStatus.Ok);
    const text = await response.text();
    const card = parseServerCard(JSON.parse(text), url);
    expect(card.$schema).toBe(SERVER_CARD_SCHEMA_URL);
    expect(card.version).toBe(version());
    expect(cardConnection(card)).toEqual({ url: `${base}${AGENTS_MCP_PATH}`, requiredHeaders: ['Authorization'] });
    expect(text).not.toContain(WORKSPACE);
  });

  it('leave the agents door itself behind its key check', async () => {
    const response = await fetch(`${base}${AGENTS_MCP_PATH}`, { method: 'POST' });
    expect(response.status).toBe(HttpStatus.Unauthorized);
  });

  it('are what a client discovering the host reads', async () => {
    const { servers, failures } = await discover(base);
    expect(failures).toEqual([]);
    expect(servers.map((found) => found.card.name)).toEqual([
      expect.stringMatching(/^io\.github\.cubicecho\.ai-router\./),
    ]);
  });
});
