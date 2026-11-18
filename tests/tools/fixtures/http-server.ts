import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

/** The header the `header` tool reports. */
export const FIXTURE_HEADER = 'x-fixture';

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
  const { port } = address;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    sessionsOpened: () => opened,
    dropSessions: () => sessions.clear(),
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}
