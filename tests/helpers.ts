import type { Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { getTableName, is, sql, Table } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { type ExecutionResult, type GraphQLSchema, graphql } from 'graphql';
import { inject } from 'vitest';
import { createRunService, type RunService } from '../server/agents/run.ts';
import { type AuthHost, fixedAuthHost } from '../server/auth/auth-host.ts';
import { type Auth, createAuth } from '../server/auth/better-auth.ts';
import { hashKey, mintKey, WORKER_KEY_PREFIX } from '../server/auth/keys.ts';
import { createRateLimiter, type RateLimiter } from '../server/auth/rate-limit.ts';
import type { OidcConfig } from '../server/core/config.ts';
import { CALLER_USER, CALLER_WORKSPACE, type Caller, type Context, type UserCaller } from '../server/core/context.ts';
import { CHILD_DEFAULTS } from '../server/core/defaults.ts';
import { relations } from '../server/db/relations.ts';
import * as dbSchema from '../server/db/schema.ts';
import { EMPTY_SNAPSHOT, loadSnapshot, type Snapshot, type SnapshotHost } from '../server/db/snapshot.ts';
import { servers } from '../server/db/tables/servers.ts';
import { Role } from '../server/db/tables/users.ts';
import { LOCAL_WORKER_NAME, workers } from '../server/db/tables/workers.ts';
import { createSchema } from '../server/graphql/build-schema.ts';
import type { UpstreamFetch } from '../server/models/outbound.ts';
import { createModelServices, type ModelServices } from '../server/models/services.ts';
import type { ToolServices } from '../server/tools/api.ts';
import { ChildMode, routerGroups } from '../server/tools/child-users.ts';
import type { RegistryFetch } from '../server/tools/registry.ts';
import { createToolServices } from '../server/tools/services.ts';
import { ADMIN_SERVER_ROW } from '../server/tools/shapes.ts';

declare module 'vitest' {
  interface ProvidedContext {
    /** The DDL for the current tables, worked out once per run by `global-setup.ts`. */
    schemaSql: string[];
  }
}

/** A database over PGlite in memory, as every test uses. */
export type TestDb = ReturnType<typeof drizzle<typeof relations>>;

/** Long enough for better-auth, and never a real secret. */
export const TEST_SECRET = 'test-secret-0123456789abcdef0123456789';
/** Where a test client's requests come from unless it says otherwise. */
export const TEST_IP = '127.0.0.1';

/** A provider fetch that reaches nothing, for tests that don't call providers. */
const UNREACHABLE: UpstreamFetch = async (url) => {
  throw new Error(`No provider is reachable in this test (${url}).`);
};

/** A registry fetch that reaches nothing, for tests that don't browse registries. */
const NO_REGISTRY: RegistryFetch = async (url) => {
  throw new Error(`No registry is reachable in this test (${url}).`);
};

/** Every table in the schema, quoted for a statement that names them all. */
const TABLE_LIST = Object.values(dbSchema)
  .flatMap((value) => (is(value, Table) ? [`"${getTableName(value)}"`] : []))
  .join(', ');

/** One schema per database: building it is most of what a client costs, and only `db` shapes it. */
const schemas = new WeakMap<object, GraphQLSchema>();

/**
 * Builds a fresh in-memory Postgres with the tables in it.
 *
 * @returns The database. A file makes one in `beforeAll`, empties it with `resetTestDb`, and closes it in `afterAll`.
 */
export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite('memory://');
  for (const statement of inject('schemaSql')) {
    await client.exec(statement);
  }
  const db = drizzle({ client, relations });
  await seedTestDb(db);
  return db;
}

/**
 * Adds what the migrations seed and the code counts on: the admin server and the local worker.
 *
 * @param db - A database with the tables and no rows.
 */
async function seedTestDb(db: TestDb): Promise<void> {
  await db.insert(servers).values(ADMIN_SERVER_ROW);
  await db.insert(workers).values({ name: LOCAL_WORKER_NAME });
}

/**
 * Empties every table, so the next test starts from the database `createTestDb` returned, with the admin server
 * and the local worker the migrations seed.
 *
 * @param db - A database from `createTestDb`.
 */
export async function resetTestDb(db: TestDb): Promise<void> {
  await db.execute(sql.raw(`TRUNCATE TABLE ${TABLE_LIST} RESTART IDENTITY CASCADE`));
  await seedTestDb(db);
}

/**
 * Shuts a test database down. One left open holds its whole Postgres in memory until the worker exits.
 *
 * @param db - A database from `createTestDb`.
 */
export async function closeTestDb(db: TestDb): Promise<void> {
  await db.$client.close();
}

/**
 * Builds better-auth over a test database.
 *
 * @param db - A database from `createTestDb`.
 * @param [oidc] - An OIDC provider to sign in with. None by default, whatever the environment says.
 * @returns The auth instance.
 */
export function createTestAuth(db: TestDb, oidc: OidcConfig | null = null): Auth {
  return createAuth(db, { secret: TEST_SECRET, oidc });
}

/**
 * Signs a user in without a provider, as the OIDC callback would.
 *
 * @param auth - The auth instance the session is made on.
 * @param userId - The user to sign in.
 * @returns The session token, to send as `Authorization: Bearer`.
 */
export async function createSessionToken(auth: Auth, userId: string): Promise<string> {
  const { internalAdapter } = await auth.$context;
  const session = await internalAdapter.createSession(userId);
  return session.token;
}

/**
 * Inserts a user straight through Drizzle. Signing up isn't what is under test.
 *
 * @param db - A database from `createTestDb`.
 * @param email - Their address, also their name.
 * @param [role] - Their role.
 * @returns The caller they would be on a session.
 */
export async function createUser(db: TestDb, email: string, role: Role = Role.User): Promise<UserCaller> {
  const [user] = await db.insert(dbSchema.users).values({ email, name: email, role }).returning();
  if (user === undefined) {
    throw new Error('The user was not inserted.');
  }
  return { kind: CALLER_USER, userId: user.id, role };
}

/**
 * Inserts a workspace and a key for it, straight through Drizzle.
 *
 * @param db - A database from `createTestDb`.
 * @param slug - The workspace's slug.
 * @param [expiresAt] - When the key stops working.
 * @returns The workspace's id, the key's id and the key itself.
 */
export async function createWorkspaceWithKey(
  db: TestDb,
  slug: string,
  expiresAt: Date | null = null,
): Promise<{ workspaceId: string; keyId: string; secret: string }> {
  const [workspace] = await db.insert(dbSchema.workspaces).values({ slug, name: slug }).returning();
  if (workspace === undefined) {
    throw new Error('The workspace was not inserted.');
  }
  const { secret, start } = mintKey();
  const [key] = await db
    .insert(dbSchema.workspaceKeys)
    .values({ workspaceId: workspace.id, name: 'test', start, hash: hashKey(secret), expiresAt })
    .returning();
  if (key === undefined) {
    throw new Error('The key was not inserted.');
  }
  return { workspaceId: workspace.id, keyId: key.id, secret };
}

/**
 * Inserts a remote worker and its key, straight through Drizzle.
 *
 * @param db - A database from `createTestDb`.
 * @param name - The worker's name.
 * @returns The worker's id and its key.
 */
export async function createWorkerWithKey(db: TestDb, name: string): Promise<{ workerId: string; secret: string }> {
  const { secret, hash, start } = mintKey(WORKER_KEY_PREFIX);
  const [worker] = await db.insert(workers).values({ name, keyHash: hash, keyPrefix: start }).returning();
  if (worker === undefined) {
    throw new Error('The worker was not inserted.');
  }
  return { workerId: worker.id, secret };
}

/**
 * The caller a workspace key makes.
 *
 * @param workspaceId - The key's workspace.
 * @param keyId - The key.
 * @returns The caller.
 */
export function workspaceCaller(workspaceId: string, keyId: string): Caller {
  return { kind: CALLER_WORKSPACE, workspaceId, keyId };
}

/** Collaborators a test shares between clients, or swaps for its own. */
export interface ClientDeps {
  /** @defaultValue a host over `createTestAuth(db)` */
  authHost?: AuthHost;
  /** @defaultValue a snapshot read again before every operation */
  snapshot?: SnapshotHost;
  /** @defaultValue `createRateLimiter()` */
  limiter?: RateLimiter;
  /** @defaultValue `TEST_IP` */
  ip?: string;
  /** @defaultValue the models area over this client's snapshot, reaching no provider */
  models?: ModelServices;
  /** @defaultValue the tools area over this client's snapshot, sharing the router's user, reaching no registry */
  tools?: ToolServices;
  /** @defaultValue the run service over this client's snapshot and tools */
  runs?: RunService;
  /** @defaultValue none */
  headers?: Headers;
}

/** What `expectError` hands back. */
export interface RefusedOperation {
  message: string;
  /** `extensions.code`, to compare with `ErrorCode`. */
  code: unknown;
  extensions: Record<string, unknown>;
}

/** A GraphQL client bound to one caller, running in-process. */
export interface TestClient {
  /** The snapshot host the client's resolvers rebuild. */
  snapshot: SnapshotHost;
  /** Executes an operation and returns the raw result. */
  run: (query: string, variables?: Record<string, unknown>) => Promise<ExecutionResult>;
  /** Runs and returns `data`. Throws the first error's original cause, so a failure reads as the real bug. */
  // biome-ignore lint/suspicious/noExplicitAny: each test reads the fields its own query asked for
  expectOk: (query: string, variables?: Record<string, unknown>) => Promise<any>;
  /** Runs and returns the first error. Throws on success. */
  expectError: (query: string, variables?: Record<string, unknown>) => Promise<RefusedOperation>;
}

/**
 * Builds a snapshot host whose snapshot is read again on demand, starting empty.
 *
 * @param db - A database from `createTestDb`.
 * @returns The host.
 */
function freshSnapshot(db: TestDb): SnapshotHost {
  let snapshot: Snapshot = EMPTY_SNAPSHOT;
  return {
    current: () => snapshot,
    rebuild: async () => {
      snapshot = await loadSnapshot(db);
    },
  };
}

/**
 * Builds a GraphQL client bound to one caller.
 *
 * @param db - A database from `createTestDb`.
 * @param caller - Who the requests are from, or null for nobody.
 * @param [deps] - Collaborators to share with other clients.
 * @returns The client.
 */
export function createClient(db: TestDb, caller: Caller | null, deps: ClientDeps = {}): TestClient {
  const { limiter = createRateLimiter(), ip = TEST_IP, headers = new Headers() } = deps;
  const authHost = deps.authHost ?? fixedAuthHost(createTestAuth(db));
  const isFresh = deps.snapshot === undefined;
  const snapshot = deps.snapshot ?? freshSnapshot(db);
  const models = deps.models ?? createModelServices({ db, snapshot, fetch: UNREACHABLE });
  const tools =
    deps.tools ??
    createToolServices({
      db,
      snapshot,
      isolation: { mode: ChildMode.Shared, reason: '' },
      registryFetch: NO_REGISTRY,
    });
  const runs = deps.runs ?? createRunService({ db, snapshot, tools });
  const schema = schemas.get(db) ?? createSchema(db);
  schemas.set(db, schema);

  const run: TestClient['run'] = async (query, variables) => {
    if (isFresh) {
      await snapshot.rebuild();
    }
    const contextValue: Context = {
      db,
      auth: authHost.current(),
      authHost,
      snapshot,
      limiter,
      models,
      tools,
      runs,
      caller,
      headers,
      ip,
    };
    return graphql({ schema, source: query, contextValue, variableValues: variables });
  };

  return {
    snapshot,
    run,
    expectOk: async (query, variables) => {
      const result = await run(query, variables);
      const [first] = result.errors ?? [];
      if (first !== undefined) {
        throw first.originalError ?? first;
      }
      return result.data;
    },
    expectError: async (query, variables) => {
      const result = await run(query, variables);
      const [error] = result.errors ?? [];
      if (error === undefined) {
        throw new Error('Expected an error, got a successful result.');
      }
      return { message: error.message, code: error.extensions.code, extensions: error.extensions };
    },
  };
}

/**
 * Reads the port a test server was given.
 *
 * @param server - A server listening on port 0.
 * @returns The port the OS picked.
 * @throws If the server is not listening on a TCP port.
 */
export function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The test server is not listening on a TCP port.');
  }
  return address.port;
}

/**
 * Picks group ids a server may be given here: the lowest the helper takes that the test process doesn't hold. A CI
 * runner's user is in `users` (100), which the router rightly refuses as one of its own.
 *
 * @param count - How many.
 * @returns That many distinct ids, lowest first.
 */
export function freeGroups(count: number): number[] {
  const held = new Set(routerGroups());
  const free: number[] = [];
  for (let gid = CHILD_DEFAULTS.firstExtraGid; free.length < count; gid += 1) {
    if (held.has(gid) === false) {
      free.push(gid);
    }
  }
  return free;
}
