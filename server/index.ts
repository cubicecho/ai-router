import './core/preflight.ts';

import path from 'node:path';
import { createAdvertiser, watchServers } from '@cubicecho/mcp-discovery/mdns';
import { upgradeStored } from './agents/upgrade.ts';
import { createAuthHost } from './auth/auth-host.ts';
import {
  appUrl,
  dbConnectTimeoutMs,
  mdnsAdvertise,
  mdnsDiscover,
  oidcRedirectUri,
  port,
  ROOT,
  secureLocalNet,
} from './core/config.ts';
import { errorMessage } from './core/errors.ts';
import { openDatabase } from './db/client.ts';
import { createSnapshotHost } from './db/snapshot.ts';
import { waitForDatabase } from './db/wait.ts';
import { AGENTS_MCP_PATH, mdnsInstanceName } from './discovery/endpoints.ts';
import { createLanServers } from './discovery/lan-servers.ts';
import { createApp } from './http/app.ts';
import { stopOnSignals } from './http/shutdown.ts';
import { ChildMode, checkChildIsolation } from './tools/child-users.ts';

/** Every interface. The container's port mapping decides who can reach it. */
const LISTEN_HOST = '0.0.0.0';

const database = openDatabase();
console.log(`[db] ${database.location}`);
try {
  await waitForDatabase(database.db, { connectTimeoutMs: dbConnectTimeoutMs() });
  // Before migrating: a second router on the same database must stop here, not race this one.
  await database.claim();
  // At boot, so `docker compose up` on a fresh volume is the whole install.
  await database.migrate();
  await upgradeStored(database.db);
} catch (error) {
  console.error(`[db] ${errorMessage(error)}`);
  await database.close().catch(() => {});
  process.exit(1);
}

const children = await checkChildIsolation();
if (children.mode === ChildMode.Shared) {
  console.warn(`[tools] ${children.reason}`);
} else if (children.mode === ChildMode.Refused) {
  console.error(`[tools] stdio MCP servers are refused: ${children.reason}`);
}

// After migrating: the provider may be a pairing, which lives in the database.
const authHost = await createAuthHost(database.db);
const snapshot = await createSnapshotHost(database.db);
// Both off unless asked for: multicast needs the host's network, and a found server is only ever a suggestion.
const advertiser = createAdvertiser({
  isWanted: mdnsAdvertise,
  options: () => ({ name: mdnsInstanceName(), port: port(), path: AGENTS_MCP_PATH }),
  log: (message) => console.log(`[discovery] ${message}`),
});
const lanServers = createLanServers({
  isWanted: mdnsDiscover,
  ownInstanceName: mdnsInstanceName(),
  servers: () => snapshot.current().servers.values(),
  log: console.log,
  watch: (handlers) => watchServers(handlers),
});
const { app, models, tools, runs } = await createApp({
  db: database.db,
  authHost,
  snapshot,
  children,
  lanServers,
  staticDir: path.join(ROOT, 'dist'),
});
models.usage.start();
models.health.start();
tools.activity.start();
// Before listening, so a retried request never finds a run that nothing is running.
const recovered = await runs.recover();
if (recovered > 0) {
  console.warn(`[runs] ${recovered} runs were going when the router stopped; they are marked failed.`);
}
runs.start();

const server = app.listen(port(), LISTEN_HOST, () => {
  console.log(`[server] ready at ${appUrl()}`);
  const oidc = authHost.oidc();
  if (oidc !== null) {
    // The redirect URI is the one thing the operator copies into the provider, exactly.
    console.log(`[auth] sign-in with ${oidc.name} (${oidc.issuer}); redirect URI ${oidcRedirectUri()}`);
  }
  if (secureLocalNet()) {
    console.warn(
      '[auth] SECURE_LOCAL_NET is on: whoever opens the UI is signed in as the admin. Apps still need a key.',
    );
  } else if (oidc === null) {
    console.warn(
      '[auth] Nobody can sign in yet: set OIDC_ISSUER, pair a provider from the sign-in page, or set SECURE_LOCAL_NET on a private network.',
    );
  }
  // After listen, so a watcher that finds the announcement can already read the catalog.
  void advertiser.sync();
  void lanServers.sync();
});

stopOnSignals(server, {
  // The goodbye goes out while the router still answers, so browsers drop it at once.
  before: async () => {
    await advertiser.close();
    await lanServers.close();
  },
  after: async () => {
    models.health.stop();
    // Runs still going end first and are recorded, then MCP servers stop, then counts and calls gathered since the
    // last write go in before the database closes.
    await runs.stop();
    await tools.stop();
    await models.usage.stop();
    await database.close();
  },
});
