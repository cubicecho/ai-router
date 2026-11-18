import './core/preflight.ts';

import path from 'node:path';
import { createAuthHost } from './auth/auth-host.ts';
import { appUrl, dbConnectTimeoutMs, oidcRedirectUri, port, ROOT, secureLocalNet } from './core/config.ts';
import { errorMessage } from './core/errors.ts';
import { openDatabase } from './db/client.ts';
import { waitForDatabase } from './db/wait.ts';
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
const { app, models, tools } = await createApp({
  db: database.db,
  authHost,
  children,
  staticDir: path.join(ROOT, 'dist'),
});
models.usage.start();
tools.activity.start();

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
});

stopOnSignals(server, {
  after: async () => {
    // MCP servers stop first, then counts and calls gathered since the last write go in before the database closes.
    await tools.stop();
    await models.usage.stop();
    await database.close();
  },
});
