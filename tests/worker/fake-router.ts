import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RunEventInput } from '@cubicecho/agent-core';
import { HttpStatus } from '../../server/core/wire.ts';
import type {
  RouterToolAnswer,
  RouterToolCall,
  RunOutcome,
  WorkerDoor,
  WorkerHello,
} from '../../server/runner/protocol.ts';
import { RUN_NOT_FOUND } from '../../server/runner/protocol.ts';

/** A tool call the fake model makes. */
export interface ModelCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** A model answer that never comes: the request stays open until the worker aborts it. */
export const HANG = Symbol('hang');

/** What the fake model answers one request with. */
export type ModelReply = ModelCall | string | typeof HANG;

/** One request the fake router heard. */
export interface Heard {
  method: string;
  path: string;
  authorization: string | undefined;
}

/** A fake ai-router: the worker doors, recording all it hears. */
export interface FakeRouter {
  url: string;
  /** Every request, in order. */
  heard: Heard[];
  hellos: WorkerHello[];
  /** Each run's events, in the order they arrived. */
  events: Map<string, RunEventInput[]>;
  toolCalls: RouterToolCall[];
  finishes: Map<string, RunOutcome>;
  /** The model door's requests: the path after `/model`, and the key. */
  modelCalls: { runId: string; path: string; authorization: string | undefined }[];
  /** What the model answers, in order, across runs. */
  replies: ModelReply[];
  /** The doors that answer 404 for a run, by run id: as if the router had dropped it. */
  notFound: Map<string, Set<WorkerDoor>>;
  /** What the tools door answers. */
  toolAnswer: (call: RouterToolCall) => RouterToolAnswer;
  /**
   * Sends one event to every open channel.
   *
   * @param event - The event's name.
   * @param data - Its data, as JSON.
   */
  send(event: string, data: unknown): void;
  /** Ends every open channel, as a restarting router would. */
  dropChannels(): void;
  /** How many channels are open. */
  openChannels(): number;
  close(): Promise<void>;
}

/** The paths of a run's doors: `/workers/runs/<id><door>`. */
const RUN_DOOR = /^\/workers\/runs\/([^/]+)(\/[a-z]+(?:\/call)?)(.*)$/;

/**
 * Writes one answer as an OpenAI chat completion stream.
 *
 * @param res - The response.
 * @param reply - A tool call, or the text the model says.
 */
function streamReply(res: ServerResponse, reply: ModelCall | string): void {
  const chunk = (body: Record<string, unknown>) =>
    `data: ${JSON.stringify({ id: 'up', object: 'chat.completion.chunk', created: 0, model: 'm1', ...body })}\n\n`;
  const choice = (delta: Record<string, unknown>, finish: string | null) =>
    chunk({ choices: [{ index: 0, delta, finish_reason: finish }] });
  const parts =
    typeof reply === 'string'
      ? [choice({ role: 'assistant', content: reply }, null), choice({}, 'stop')]
      : [
          choice(
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: reply.id,
                  type: 'function',
                  function: { name: reply.name, arguments: JSON.stringify(reply.args) },
                },
              ],
            },
            null,
          ),
          choice({}, 'tool_calls'),
        ];
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  res.writeHead(HttpStatus.Ok, { 'content-type': 'text/event-stream' });
  res.end([...parts, chunk({ choices: [], usage }), 'data: [DONE]\n\n'].join(''));
}

/**
 * Reads a request's body as JSON.
 *
 * @param req - The request.
 * @returns The body, or undefined when it has none.
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
}

/**
 * Answers with JSON.
 *
 * @param res - The response.
 * @param status - Its status.
 * @param body - Its body.
 */
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Starts a fake router on a free port.
 *
 * @returns The router.
 */
export async function startFakeRouter(): Promise<FakeRouter> {
  const channels = new Set<ServerResponse>();
  const router: FakeRouter = {
    url: '',
    close: () => Promise.resolve(),
    heard: [],
    hellos: [],
    events: new Map(),
    toolCalls: [],
    finishes: new Map(),
    modelCalls: [],
    replies: [],
    notFound: new Map(),
    toolAnswer: (call) => ({ ok: true, text: `echoed ${JSON.stringify(call.args)}` }),
    send: (event, data) => {
      for (const res of channels) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    },
    dropChannels: () => {
      for (const res of channels) {
        res.end();
      }
      channels.clear();
    },
    openChannels: () => channels.size,
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = req.url ?? '';
    const { authorization } = req.headers;
    router.heard.push({ method: req.method ?? '', path, authorization });
    if (path === '/workers/channel') {
      res.writeHead(HttpStatus.Ok, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': open\n\n');
      channels.add(res);
      req.on('close', () => channels.delete(res));
      return;
    }
    if (path === '/workers/hello') {
      router.hellos.push((await readJson(req)) as WorkerHello);
      json(res, HttpStatus.Ok, { ok: true });
      return;
    }
    const match = RUN_DOOR.exec(path);
    if (match === null) {
      json(res, HttpStatus.NotFound, { error: 'no such door' });
      return;
    }
    const [, encodedId = '', door = '', rest = ''] = match;
    const runId = decodeURIComponent(encodedId);
    if (router.notFound.get(runId)?.has(door as WorkerDoor)) {
      await readJson(req).catch(() => undefined);
      json(res, HttpStatus.NotFound, { error: 'This run is not running on this worker.', code: RUN_NOT_FOUND });
      return;
    }
    if (door === '/model') {
      router.modelCalls.push({ runId, path: rest, authorization });
      await readJson(req);
      if (rest !== '/chat/completions') {
        json(res, HttpStatus.NotFound, { error: { message: 'not here', type: 'invalid_request_error' } });
        return;
      }
      const reply = router.replies.shift();
      if (reply === HANG) {
        res.writeHead(HttpStatus.Ok, { 'content-type': 'text/event-stream' });
        return;
      }
      streamReply(res, reply ?? 'nothing more to say');
      return;
    }
    if (door === '/tools/call') {
      const call = (await readJson(req)) as RouterToolCall;
      router.toolCalls.push(call);
      json(res, HttpStatus.Ok, router.toolAnswer(call));
      return;
    }
    if (door === '/events') {
      const { events } = (await readJson(req)) as { events: RunEventInput[] };
      router.events.set(runId, [...(router.events.get(runId) ?? []), ...events]);
      json(res, HttpStatus.Ok, { ok: true });
      return;
    }
    if (door === '/finish') {
      router.finishes.set(runId, (await readJson(req)) as RunOutcome);
      json(res, HttpStatus.Ok, { ok: true });
      return;
    }
    json(res, HttpStatus.NotFound, { error: 'no such door' });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => json(res, HttpStatus.InternalServerError, { error: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  router.url = `http://127.0.0.1:${port}`;
  router.close = async () => {
    router.dropChannels();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return router;
}
