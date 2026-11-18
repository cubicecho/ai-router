// Checks that must pass before anything opens a connection or signs a token. The first import of
// index.ts, so a misconfigured router fails with a sentence rather than a stack trace.
import {
  allowsPublicLocalNet,
  appUrl,
  configuredAuthSecret,
  databaseUrl,
  describeWeakSecret,
  isPostgresUrl,
  isProduction,
  OIDC_CLIENT_AUTH_METHODS,
  secureLocalNet,
} from './config.ts';
import { isPrivateHost } from './hosts.ts';

/**
 * Reports a configuration fault and exits with status 1.
 *
 * @param message - What is wrong and how to fix it.
 * @returns Never.
 */
function fatal(message: string): never {
  console.error(`[preflight] ${message}`);
  process.exit(1);
}

const url = databaseUrl();
if (url === '') {
  fatal('DATABASE_URL is required. Copy .env.example to .env, then run `npm run db:up` for a local Postgres.');
}
if (isPostgresUrl(url) === false) {
  fatal('DATABASE_URL must be a postgres:// URL. The router runs on Postgres; PGlite is for tests only.');
}

if (isProduction()) {
  // A known or guessable secret lets anyone forge a session for any account.
  const weakness = describeWeakSecret(configuredAuthSecret());
  if (weakness !== undefined) {
    fatal(`BETTER_AUTH_SECRET ${weakness}. Set a strong random value: generate one with \`openssl rand -hex 32\`.`);
  }
}

if (secureLocalNet()) {
  const hostname = new URL(appUrl()).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isExposed = isPrivateHost(hostname) === false && allowsPublicLocalNet() === false;
  // Whoever opens the UI is the admin, so the network must be the router's own.
  if (isExposed) {
    fatal(
      `SECURE_LOCAL_NET is on but APP_URL (${appUrl()}) is not a private address. Turn it off, or set I_KNOW_SECURE_LOCAL_NET_IS_PUBLIC=true if nothing hostile can reach this port.`,
    );
  }
}

// Half an OIDC setup leaves the sign-in page without its button and no clue why.
const oidcIssuer = process.env.OIDC_ISSUER?.trim() ?? '';
const oidcClientId = process.env.OIDC_CLIENT_ID?.trim() ?? '';
if ((oidcIssuer === '') !== (oidcClientId === '')) {
  fatal('OIDC_ISSUER and OIDC_CLIENT_ID go together: set both to sign in with an OIDC provider, or neither.');
}
const isIssuerUrl = URL.canParse(oidcIssuer);
if (oidcIssuer !== '' && isIssuerUrl === false) {
  fatal(`OIDC_ISSUER is not a URL: ${oidcIssuer}`);
}
const oidcClientAuth = process.env.OIDC_CLIENT_AUTH?.trim() ?? '';
const isKnownClientAuth = OIDC_CLIENT_AUTH_METHODS.some((method) => method === oidcClientAuth);
if (oidcClientAuth !== '' && isKnownClientAuth === false) {
  fatal(`OIDC_CLIENT_AUTH must be one of ${OIDC_CLIENT_AUTH_METHODS.join(', ')}.`);
}
