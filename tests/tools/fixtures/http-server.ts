import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

/** The header the `header` tool reports. */
export const FIXTURE_HEADER = 'x-fixture';

/** Where the SSE fixture streams its events. */
const SSE_PATH = '/sse';
/** Where the SSE fixture takes messages, as it tells the client once the stream is open. */
const MESSAGES_PATH = '/messages';

/** A handler a loopback fixture answers each request with. */
type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** A fixture listening on loopback. */
interface Listening {
  /** Its origin, such as `http://127.0.0.1:41234`. */
  origin: string;
  /** Closes it and every connection still open, event streams included. */
  close: () => Promise<void>;
}

/** A streamable-HTTP MCP server on loopback, for the instance tests. */
export interface HttpFixture {
  /** Its MCP address. */
  url: string;
  /** How many sessions it has opened. */
  sessionsOpened: () => number;
  /** Forgets every session, as a restarted server would: the next request on one is answered 404. */
  dropSessions: () => void;
  close: () => Promise<void>;
}

/**
 * Builds the MCP server behind one session.
 *
 * @returns The server, with `echo` and `header` tools.
 */
function fixtureServer(): McpServer {
  const server = new McpServer({ name: 'http-fixture', version: '1.0.0' });
  server.registerTool('header', { description: `Reports the ${FIXTURE_HEADER} header.` }, (extra) => ({
    content: [{ type: 'text' as const, text: String(extra.requestInfo?.headers[FIXTURE_HEADER] ?? '') }],
  }));
  return server;
}

/**
 * Reads a request's JSON body.
 *
 * @param req - The request.
 * @returns The parsed body, or undefined when there is none.
 */
async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString();
  return raw === '' ? undefined : JSON.parse(raw);
}

/**
 * Listens on a free loopback port, answering a handler's failure with a 500.
 *
 * @param handle - What answers each request.
 * @returns Where it listens, and how to close it.
 */
async function listenOnLoopback(handle: Handler): Promise<Listening> {
  const http = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the fixture is not listening on a port');
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

/**
 * Starts the fixture on a free loopback port.
 *
 * @returns The fixture.
 */
export async function startHttpFixture(): Promise<HttpFixture> {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let opened = 0;

  /**
   * Answers one request: a new session on initialize, its session's transport otherwise, and 404 for a session it
   * doesn't know.
   *
   * @param req - The request.
   * @param res - The response.
   */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const transport = sessions.get(sessionId);
      if (transport === undefined) {
        res.writeHead(404).end('unknown session');
        return;
      }
      await transport.handleRequest(req, res, body);
      return;
    }
    if (isInitializeRequest(body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          sessions.set(id, transport);
          opened += 1;
        },
      });
      await fixtureServer().connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(400).end('no session');
  }

  const { origin, close } = await listenOnLoopback(handle);
  return {
    url: `${origin}/mcp`,
    sessionsOpened: () => opened,
    dropSessions: () => sessions.clear(),
    close,
  };
}

/** An MCP server on loopback that speaks the older HTTP+SSE transport, for the instance and services tests. */
export interface SseFixture {
  /** Its event stream's address. */
  url: string;
  /** The `x-fixture` header the last event stream was opened with, which the `header` tool can't see. */
  streamHeader: () => string;
  close: () => Promise<void>;
}

/**
 * Starts the SSE fixture on a free loopback port: a stream per session at `/sse`, and its messages posted to
 * `/messages?sessionId=…`.
 *
 * @returns The fixture.
 */
export async function startSseFixture(): Promise<SseFixture> {
  const sessions = new Map<string, SSEServerTransport>();
  let streamHeader = '';

  /**
   * Answers one request: a new session on a stream, its session's transport for a message, and 404 otherwise.
   *
   * @param req - The request.
   * @param res - The response.
   */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fixture');
    if (req.method === 'GET' && url.pathname === SSE_PATH) {
      streamHeader = String(req.headers[FIXTURE_HEADER] ?? '');
      const transport = new SSEServerTransport(MESSAGES_PATH, res);
      sessions.set(transport.sessionId, transport);
      res.on('close', () => sessions.delete(transport.sessionId));
      await fixtureServer().connect(transport);
      return;
    }
    const transport = sessions.get(url.searchParams.get('sessionId') ?? '');
    if (req.method === 'POST' && url.pathname === MESSAGES_PATH && transport !== undefined) {
      await transport.handlePostMessage(req, res, await readBody(req));
      return;
    }
    res.writeHead(404).end('unknown session');
  }

  const { origin, close } = await listenOnLoopback(handle);
  return { url: `${origin}${SSE_PATH}`, streamHeader: () => streamHeader, close };
}
