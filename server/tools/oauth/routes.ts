import { randomBytes } from 'node:crypto';
import { type Request, type Response, Router } from 'express';
import { GraphQLError } from 'graphql';
import { appUrl } from '../../core/config.ts';
import { ErrorCode, errorMessage } from '../../core/errors.ts';
import { HttpStatus } from '../../core/wire.ts';
import {
  clientMetadataUrl,
  routerClientMetadata,
  SERVER_LOGIN_CALLBACK_PATH,
  SERVER_LOGIN_METADATA_PATH,
} from './provider.ts';
import type { FinishedServerLogin, ServerLoginService } from './service.ts';

/** The `type` of the message the callback page posts to the window that opened it. */
export const SERVER_LOGIN_MESSAGE_TYPE = 'ai-router-server-login' as const;

/** What the callback page posts to the UI, then closes on success. Never carries a token. */
export interface ServerLoginMessage {
  type: typeof SERVER_LOGIN_MESSAGE_TYPE;
  /** The server the login was for. null when the callback named no login this process knows. */
  serverId: string | null;
  /** Its name, for the page and a toast. null with `serverId`. */
  serverName: string | null;
  ok: boolean;
  /** Why it failed. null on success. */
  error: string | null;
}

/** Random bytes in the callback page's script nonce. */
const NONCE_BYTES = 16;

/** The status a failed callback answers, by the error's `extensions.code`. Anything else is the login's fault. */
const STATUS_BY_CODE = new Map<unknown, HttpStatus>([
  [ErrorCode.BadUserInput, HttpStatus.BadRequest],
  [ErrorCode.NotFound, HttpStatus.NotFound],
  [ErrorCode.UpstreamFailed, HttpStatus.BadGateway],
]);

/** The characters HTML gives meaning to, with their escapes. */
const HTML_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/**
 * Escapes text for HTML.
 *
 * @param text - Any text.
 * @returns It, safe between tags and inside a quoted attribute.
 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** What JSON may hold that would end a `<script>` element or a JS line, with its JSON escape. */
const SCRIPT_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
});

/**
 * Writes a value as JSON that is safe inside a `<script>` element.
 *
 * @param value - Anything JSON can hold.
 * @returns The JSON, with every character that could close the element escaped.
 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => SCRIPT_ESCAPES[character] ?? character);
}

/**
 * The page a server's login sends the browser back to: says how it went, tells the UI, and closes on success.
 *
 * @param message - What the opener is told.
 * @param nonce - The script nonce the page's content security policy allows.
 * @returns The HTML.
 *
 * @remarks
 * The message is posted to the UI's origin alone, so a page that opened the callback itself hears nothing.
 */
export function serverLoginPage(message: ServerLoginMessage, nonce: string): string {
  const heading = message.ok ? 'Signed in' : 'Login failed';
  const server = message.serverName ?? 'the server';
  const body = message.ok
    ? `ai-router is signed in to ${server}. You can close this window.`
    : (message.error ?? 'The login did not finish.');
  const uiOrigin = new URL(appUrl()).origin;
  const closing = message.ok ? 'window.close();' : '';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(heading)} · ai-router</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1f2328;background:#fff}@media (prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}}</style></head>
<body><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p>
<script nonce="${escapeHtml(nonce)}">
if (window.opener) {
  window.opener.postMessage(${scriptJson(message)}, ${scriptJson(uiOrigin)});
  ${closing}
}
</script></body>
</html>`;
}

/**
 * Reads one query parameter as text.
 *
 * @param req - The request.
 * @param name - The parameter.
 * @returns Its value, or null when it is missing or repeated.
 */
function queryText(req: Request, name: string): string | null {
  const value = req.query[name];
  return typeof value === 'string' ? value : null;
}

/**
 * Answers the callback page.
 *
 * @param res - The response.
 * @param status - The HTTP status.
 * @param message - What the page says and posts.
 */
function sendPage(res: Response, status: HttpStatus, message: ServerLoginMessage): void {
  const nonce = randomBytes(NONCE_BYTES).toString('base64');
  res
    .status(status)
    .type('html')
    .set({
      'Cache-Control': 'no-store',
      // The URL carries the code: it goes nowhere else.
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`,
    })
    .send(serverLoginPage(message, nonce));
}

/**
 * Builds the message for a login that failed.
 *
 * @param login - Which server it was for, or null when unknown.
 * @param error - Why.
 * @returns The message.
 */
function failure(login: FinishedServerLogin | null, error: string): ServerLoginMessage {
  return {
    type: SERVER_LOGIN_MESSAGE_TYPE,
    serverId: login?.serverId ?? null,
    serverName: login?.serverName ?? null,
    ok: false,
    error,
  };
}

/**
 * Finishes a login from the callback, and answers the page that reports it.
 *
 * @param service - Server login.
 * @param req - The server's login sending the browser back.
 * @param res - Answered with the page.
 * @returns Once the page is sent.
 */
async function callback(service: ServerLoginService, req: Request, res: Response): Promise<void> {
  const state = queryText(req, 'state') ?? '';
  const code = queryText(req, 'code');
  const refusal = queryText(req, 'error');
  if (refusal !== null || code === null) {
    const login = service.abandon(state);
    const description = queryText(req, 'error_description') ?? refusal;
    const error =
      description === null ? 'The login sent no authorization code back.' : `The login refused: ${description}`;
    sendPage(res, HttpStatus.BadRequest, failure(login, error));
    return;
  }
  try {
    const { serverId, serverName } = await service.finish(state, code);
    sendPage(res, HttpStatus.Ok, { type: SERVER_LOGIN_MESSAGE_TYPE, serverId, serverName, ok: true, error: null });
  } catch (cause) {
    const errorCode = cause instanceof GraphQLError ? cause.extensions.code : undefined;
    console.warn(`[server-login] callback failed: ${errorMessage(cause)}`);
    sendPage(res, STATUS_BY_CODE.get(errorCode) ?? HttpStatus.BadGateway, failure(null, errorMessage(cause)));
  }
}

/**
 * Builds the two server-login endpoints a server's login calls without a session: the redirect back and the client
 * metadata document. Mount at the root, before the static handler.
 *
 * @param service - Finishes the logins.
 * @returns The router, answering `GET /oauth/callback` and `GET /oauth/client-metadata.json`.
 *
 * @remarks
 * The callback needs no session because its `state` is the credential: unguessable, made for a login a user started,
 * short-lived, and good once.
 */
export function createServerLoginRoutes(service: ServerLoginService): Router {
  const router = Router();
  // The router's client id at a login that takes a URL as one (Client ID Metadata Documents; Home Assistant).
  router.get(SERVER_LOGIN_METADATA_PATH, (_req, res) => {
    res.json({ client_id: clientMetadataUrl(), client_uri: appUrl(), ...routerClientMetadata() });
  });
  router.get(SERVER_LOGIN_CALLBACK_PATH, (req, res) => callback(service, req, res));
  return router;
}
