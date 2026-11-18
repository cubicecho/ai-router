import express, { type Express } from 'express';
import { type AuthHost, createAuthHost } from '../auth/auth-host.ts';
import { createRateLimiter, type RateLimiter } from '../auth/rate-limit.ts';
import { trustProxy as configuredTrustProxy } from '../core/config.ts';
import { HTTP_DEFAULTS, type HttpSettings } from '../core/defaults.ts';
import { HttpStatus } from '../core/wire.ts';
import type { DB } from '../db/client.ts';
import { createSnapshotHost, type SnapshotHost } from '../db/snapshot.ts';
import { createSchema } from '../graphql/build-schema.ts';
import { createContextFactory, createGraphQLHandler } from '../graphql/handler.ts';
import { createModelServices, type ModelServices } from '../models/services.ts';
import { type ChildIsolation, ChildMode } from '../tools/child-users.ts';
import { createServerLoginRoutes } from '../tools/oauth/routes.ts';
import { createToolServices, type ToolServiceParts } from '../tools/services.ts';
import { checkHealth } from './health.ts';
import { mountSso } from './sso.ts';
import { createStaticHandler } from './static.ts';

/** What the router talks to. Tests pass PGlite and leave the rest to the defaults. */
export interface AppDeps {
  db: DB;
  /**
   * Hands out the current auth instance.
   * @defaultValue `createAuthHost(db)`, which reads the paired provider, so migrations must have run.
   */
  authHost?: AuthHost;
  /**
   * What the gateways route by.
   * @defaultValue `createSnapshotHost(db)`
   */
  snapshot?: SnapshotHost;
  /**
   * Sign-in throttle.
   * @defaultValue `createRateLimiter()`
   */
  limiter?: RateLimiter;
  /**
   * The models area.
   * @defaultValue `createModelServices` over this app's snapshot
   */
  models?: ModelServices;
  /**
   * The tools area.
   * @defaultValue `createToolServices` over this app's snapshot and `children`
   */
  tools?: ToolServiceParts;
  /**
   * What the boot check found about running MCP servers as their own users. Reported on /healthz.
   * @defaultValue shared, with no reason: tests start no servers.
   */
  children?: ChildIsolation;
  /**
   * Express's `trust proxy`.
   * @defaultValue `trustProxy()` from the environment
   */
  trustProxy?: HttpSettings['trustProxy'];
  /** The built UI's directory. Left out in tests that do not serve it. */
  staticDir?: string;
}

/** What `createApp` hands back. */
export interface BuiltApp {
  /** The Express app, not listening. */
  app: Express;
  /** The snapshot host the app routes by, for background work that writes. */
  snapshot: SnapshotHost;
  /** The models area, whose usage recorder boot starts and shutdown stops. */
  models: ModelServices;
  /** The tools area, whose activity recorder boot starts and whose instances shutdown stops. */
  tools: ToolServiceParts;
}

/**
 * Builds the Express app: /graphql, /healthz, the OIDC redirects and the UI.
 *
 * @param deps - What the router talks to.
 * @returns The app and its snapshot host. It does not listen, migrate or start timers.
 */
export async function createApp({
  db,
  authHost,
  snapshot,
  limiter = createRateLimiter(),
  models,
  tools,
  children = { mode: ChildMode.Shared, reason: '' },
  trustProxy = configuredTrustProxy(),
  staticDir,
}: AppDeps): Promise<BuiltApp> {
  const app = express();
  // Decides what `request.ip` is, and the sign-in throttle is keyed by it.
  app.set('trust proxy', trustProxy);
  app.disable('x-powered-by');
  const host = authHost ?? (await createAuthHost(db));
  const routes = snapshot ?? (await createSnapshotHost(db));
  const services = models ?? createModelServices({ db, snapshot: routes });
  const toolServices = tools ?? createToolServices({ db, snapshot: routes, isolation: children });
  const contextFor = createContextFactory({
    db,
    authHost: host,
    snapshot: routes,
    limiter,
    models: services,
    tools: toolServices,
  });
  const graphql = createGraphQLHandler(createSchema(db), contextFor);

  // Yoga reads a body Express already parsed, so the size cap goes here. Over it: 413.
  app.use(graphql.graphqlEndpoint, express.json({ limit: HTTP_DEFAULTS.bodyLimit }));
  // `all`, not `use`: a mounted `use` strips the path, and Yoga matches graphqlEndpoint itself.
  app.all(graphql.graphqlEndpoint, (request, response) => graphql(request, response));
  app.get('/healthz', async (_request, response) => {
    const health = await checkHealth(db, children);
    response.status(health.ok ? HttpStatus.Ok : HttpStatus.ServiceUnavailable).json(health);
  });
  // Before the static handler, whose fallback would answer both paths with the UI. Always mounted,
  // because a provider can be paired while the router runs.
  mountSso(app, host);
  // A remote server's login comes back here. The state it carries is the credential, so no session is asked for.
  app.use(createServerLoginRoutes(toolServices.logins));
  if (staticDir !== undefined) {
    const serveStatic = createStaticHandler(staticDir);
    app.use((request, response) => serveStatic(request, response));
  }
  return { app, snapshot: routes, models: services, tools: toolServices };
}
