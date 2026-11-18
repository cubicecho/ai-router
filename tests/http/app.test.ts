import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedAuthHost } from '../../server/auth/auth-host.ts';
import { version } from '../../server/core/config.ts';
import { OPERATION_LIMIT_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { createApp } from '../../server/http/app.ts';
import { ChildMode } from '../../server/tools/child-users.ts';
import {
  closeTestDb,
  createSessionToken,
  createTestAuth,
  createTestDb,
  createUser,
  createWorkspaceWithKey,
  portOf,
  type TestDb,
} from '../helpers.ts';

// The app production runs, against PGlite, over a real socket: routing order, masking, the limits,
// the body cap and the Authorization header, which in-process `graphql()` never sees.

const INDEX = '<!doctype html><title>ai-router</title>';
const WORKSPACES = '{ workspaces { id } }';
/** Past `HTTP_DEFAULTS.bodyLimit`, which is 1 MB. */
const OVERSIZED_BODY_BYTES = 1_100_000;

let staticDir: string;
let server: Server;
let base: string;
let token: string;
let keySecret: string;
let db: TestDb;

/** A GraphQL response body, shaped by the caller. */
// biome-ignore lint/suspicious/noExplicitAny: each test reads the fields its own query asked for
type AnyBody = any;

/**
 * Posts an operation to /graphql.
 *
 * @param query - The operation.
 * @param [headers] - Extra headers, such as the credential.
 * @returns The response.
 */
const post = (query: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });

/**
 * Posts an operation and reads the body.
 *
 * @param query - The operation.
 * @param [headers] - Extra headers.
 * @returns The JSON body.
 */
const ask = async (query: string, headers: Record<string, string> = {}): Promise<AnyBody> =>
  (await post(query, headers)).json();

beforeAll(async () => {
  staticDir = mkdtempSync(join(tmpdir(), 'ai-router-app-'));
  writeFileSync(join(staticDir, 'index.html'), INDEX);
  db = await createTestDb();
  const auth = createTestAuth(db);
  const ada = await createUser(db, 'ada@example.com');
  token = await createSessionToken(auth, ada.userId);
  keySecret = (await createWorkspaceWithKey(db, 'min-agent')).secret;
  const children = { mode: ChildMode.Isolated, reason: '' };
  const { app } = await createApp({ db, authHost: fixedAuthHost(auth), staticDir, children, trustProxy: false });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${portOf(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb(db);
  rmSync(staticDir, { recursive: true, force: true });
});

describe('app', () => {
  it('answers /healthz with the version and how children run', async () => {
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(HttpStatus.Ok);
    expect(await response.json()).toEqual({ ok: true, version: version(), children: ChildMode.Isolated });
  });

  it('serves the UI for its own paths', async () => {
    const response = await fetch(`${base}/workspaces/min-agent`);
    expect(response.status).toBe(HttpStatus.Ok);
    expect(await response.text()).toBe(INDEX);
  });

  it.each(['/v1/models', '/bare/v1/models', '/bare/mcp', '/mcp', '/agents', '/runs/x'])(
    'never answers %s with the UI',
    async (path) => {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(HttpStatus.NotFound);
      expect(await response.text()).not.toContain(INDEX);
    },
  );

  it('answers a signed-in person', async () => {
    const body = await ask(WORKSPACES, { authorization: `Bearer ${token}` });
    expect(body.data.workspaces).toHaveLength(1);
  });

  it('refuses nobody with UNAUTHENTICATED', async () => {
    const body = await ask(WORKSPACES);
    expect(body.errors[0].extensions.code).toBe(ErrorCode.Unauthenticated);
  });

  it('refuses a workspace key, sent either way', async () => {
    const sent: Record<string, string>[] = [{ authorization: `Bearer ${keySecret}` }, { 'x-api-key': keySecret }];
    for (const headers of sent) {
      const body = await ask(WORKSPACES, headers);
      expect(body.errors[0].extensions.code).toBe(ErrorCode.Forbidden);
    }
  });

  it('refuses a request that sends two different keys', async () => {
    const body = await ask(WORKSPACES, { authorization: `Bearer ${token}`, 'x-api-key': keySecret });
    expect(body.errors[0].extensions.code).toBe(ErrorCode.BadUserInput);
  });

  it('lets the sign-in page read authConfig signed out', async () => {
    const body = await ask('{ authConfig { trustedNetwork } }');
    expect(body.data.authConfig).toEqual({ trustedNetwork: false });
  });

  it('refuses a query deeper than maxDepth before running it', async () => {
    const nest = (levels: number): string => (levels === 0 ? 'id' : `keys { workspace { ${nest(levels - 1)} } }`);
    const body = await ask(`{ workspaces { ${nest(OPERATION_LIMIT_DEFAULTS.maxDepth)} } }`);
    expect(body.errors[0].extensions.code).toBe(ErrorCode.QueryTooComplex);
    expect(body.data).toBeUndefined();
  });

  it('rejects a body over the body limit with 413', async () => {
    const response = await fetch(`${base}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }', variables: { pad: 'x'.repeat(OVERSIZED_BODY_BYTES) } }),
    });
    expect(response.status).toBe(HttpStatus.PayloadTooLarge);
  });

  it('serves none of the router-only tables', async () => {
    for (const field of ['sessions', 'accounts', 'verifications', 'oidcSettings']) {
      const body = await ask(`{ ${field} { id } }`, { authorization: `Bearer ${token}` });
      expect(body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
    }
  });
});
