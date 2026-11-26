import { type RunEventInput, RunEventKind } from '@cubicecho/agent-core';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { NOT_JSON, TOO_LARGE } from '../agents/routes.ts';
import { ConflictingKeysError, readWorkerCaller } from '../auth/caller.ts';
import type { WorkerCaller } from '../core/context.ts';
import { ErrorCode, errorMessage } from '../core/errors.ts';
import { headersOf } from '../core/headers.ts';
import { isRecord } from '../core/is-record.ts';
import { HttpStatus, MODELS_BASE_URL } from '../core/wire.ts';
import type { SnapshotHost } from '../db/snapshot.ts';
import { SESSION_HEADER } from '../models/affinity.ts';
import { TOOL_ORIGIN_ROUTER } from '../runner/assignment.ts';
import {
  type ChannelMessage,
  ChannelMessageType,
  eventBatchSchema,
  type RouterToolAnswer,
  RUN_NOT_FOUND,
  type RunOutcome,
  routerToolCallSchema,
  runOutcomeSchema,
  WorkerDoor,
  workerHelloSchema,
} from '../runner/protocol.ts';
import type { RemoteRun, RemoteWorkers } from './remote.ts';

/** The content type of the channel. */
const EVENT_STREAM_TYPE = 'text/event-stream';
/** The content type of a JSON body. */
const JSON_TYPE = 'application/json';
/** The request headers the model door passes on: what the body is and how the worker reads the answer. */
const FORWARDED_HEADERS = ['content-type', 'accept'];
/** The answer headers the model door passes back. */
const ANSWERED_HEADERS = ['content-type', 'cache-control'];
/** Every kind of event agent-core's loop says, which is all a batch may carry. */
const RUN_EVENT_KINDS = new Set<string>(Object.values(RunEventKind));
/** A run's id, before it is looked up. */
const runIdSchema = z.uuid();

/** What the worker doors talk to. */
export interface WorkerRoutesDeps {
  /** What worker keys are checked against. */
  snapshot: SnapshotHost;
  /** The online workers and the runs on them. */
  workers: RemoteWorkers;
}

/** A request that got past the key check: which worker it is from. */
interface WorkerLocals {
  caller: WorkerCaller;
  /** The run a run door names, once found executing on this worker. */
  run?: RemoteRun;
}

/** A worker door's answer, with who is asking. */
type WorkerResponse = Response<unknown, WorkerLocals>;

/**
 * Answers in the `/runs` error format, with the codes GraphQL uses, or the protocol's own for a run not here.
 *
 * @param response - The answer.
 * @param status - The HTTP status.
 * @param code - The code.
 * @param error - What the worker is told.
 */
function refuse(response: Response, status: HttpStatus, code: ErrorCode | typeof RUN_NOT_FOUND, error: string): void {
  response.status(status).json({ error, code });
}

/**
 * Whether an event a worker sent is one of the loop's.
 *
 * @param event - The event, as the batch's schema read it.
 * @returns True when its kind is one agent-core says. The router checks nothing else, and numbers it itself.
 */
function isLoopEvent(event: { kind: string }): event is RunEventInput {
  return RUN_EVENT_KINDS.has(event.kind);
}

/**
 * Whether a worker's `finish` body is a stretch's outcome.
 *
 * @param body - The body.
 * @returns True when it has the shape the protocol states. The loop's own fields (usage, messages) are the worker's.
 */
function isOutcome(body: unknown): body is RunOutcome {
  return runOutcomeSchema.safeParse(body).success;
}

/**
 * Writes one channel message as a server-sent event named by its type.
 *
 * @param message - The message.
 * @returns The event's text.
 */
function channelEvent(message: ChannelMessage): string {
  return `event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`;
}

/**
 * Builds a signal that aborts when the worker's request closes before its answer is sent, or the run stops.
 *
 * @param response - The answer.
 * @param run - The run.
 * @returns The signal.
 */
function requestSignal(response: Response, run: RemoteRun): AbortSignal {
  const closed = new AbortController();
  response.on('close', () => {
    if (response.writableFinished === false) {
      closed.abort();
    }
  });
  return AbortSignal.any([closed.signal, run.ports.signal]);
}

/**
 * Builds the worker doors, under `WORKERS_PATH`: the channel, the hello, and each run's model, tool, event and finish
 * doors. Only worker keys are read here, never a workspace key or a session.
 *
 * @param deps - The snapshot and the remote workers.
 * @returns The router, to mount at `WORKERS_PATH`.
 *
 * @remarks
 * A run door answers 404 unless the run is executing on the calling worker now. The model door passes on the body and
 * the content type only, never the worker's key.
 */
export function createWorkerRoutes({ snapshot, workers }: WorkerRoutesDeps): Router {
  const { registry, settings } = workers;
  const router = express.Router();

  router.use((request: Request, response: WorkerResponse, next: NextFunction) => {
    let caller: WorkerCaller | null;
    try {
      caller = readWorkerCaller(snapshot.current(), headersOf(request));
    } catch (error) {
      if (error instanceof ConflictingKeysError) {
        refuse(response, HttpStatus.BadRequest, ErrorCode.BadUserInput, error.message);
        return;
      }
      throw error;
    }
    if (caller === null) {
      refuse(
        response,
        HttpStatus.Unauthorized,
        ErrorCode.Unauthenticated,
        'Send a worker key as Authorization: Bearer.',
      );
      return;
    }
    response.locals.caller = caller;
    next();
  });
  router.use(express.json({ limit: settings.bodyLimit }));

  router.get(WorkerDoor.Channel, (_request: Request, response: WorkerResponse) => {
    const { workerId, name } = response.locals.caller;
    response.status(HttpStatus.Ok);
    response.setHeader('content-type', EVENT_STREAM_TYPE);
    response.setHeader('cache-control', 'no-cache');
    response.setHeader('x-accel-buffering', 'no');
    response.flushHeaders();
    const isGone = (): boolean => response.destroyed || response.writableEnded;
    const disconnect = registry.connect(workerId, {
      send: (message) => {
        if (isGone() === false) {
          response.write(channelEvent(message));
        }
      },
      close: () => response.end(),
    });
    console.info(`[workers] worker ${name} dialled in`);
    const ping = setInterval(() => registry.send(workerId, { type: ChannelMessageType.Ping }), settings.heartbeatMs);
    ping.unref();
    response.on('close', () => {
      clearInterval(ping);
      disconnect();
      console.info(`[workers] worker ${name}'s channel closed`);
    });
  });

  router.post(WorkerDoor.Hello, async (request: Request, response: WorkerResponse) => {
    const parsed = workerHelloSchema.safeParse(request.body);
    if (parsed.success === false) {
      const said = 'Send the worker hello: its host, its version and its servers with their tools.';
      refuse(response, HttpStatus.BadRequest, ErrorCode.BadUserInput, said);
      return;
    }
    const { workerId } = response.locals.caller;
    await registry.hello(workerId, parsed.data);
    workers.hold(workerId, parsed.data.runs);
    response.json({ ok: true });
  });

  router.use('/runs/:id', (request: Request<{ id: string }>, response: WorkerResponse, next: NextFunction) => {
    const { id } = request.params;
    const run = runIdSchema.safeParse(id).success ? workers.running(response.locals.caller.workerId, id) : undefined;
    if (run === undefined) {
      // A run on another worker, or one not executing now, is as missing as one that never was.
      refuse(response, HttpStatus.NotFound, RUN_NOT_FOUND, 'No run with that id is executing on this worker.');
      return;
    }
    response.locals.run = run;
    next();
  });

  /**
   * Reads the run a run door's middleware found.
   *
   * @param response - The answer.
   * @returns The run.
   */
  const runOf = (response: WorkerResponse): RemoteRun => {
    const { run } = response.locals;
    if (run === undefined) {
      throw new Error('A run door was reached without its run.');
    }
    return run;
  };

  router.use(`/runs/:id${WorkerDoor.Model}`, async (request: Request, response: WorkerResponse) => {
    const run = runOf(response);
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const headers = new Headers({ [SESSION_HEADER]: run.assignment.runId });
    for (const name of FORWARDED_HEADERS) {
      const value = request.get(name);
      if (value !== undefined) {
        headers.set(name, value);
      }
    }
    if (hasBody) {
      headers.set('content-type', JSON_TYPE);
    }
    const answer = await run.ports.modelFetch(`${MODELS_BASE_URL}${request.url}`, {
      method: request.method,
      headers,
      ...(hasBody ? { body: JSON.stringify(request.body ?? {}) } : {}),
      signal: requestSignal(response, run),
    });
    response.status(answer.status);
    for (const name of ANSWERED_HEADERS) {
      const value = answer.headers.get(name);
      if (value !== null) {
        response.setHeader(name, value);
      }
    }
    if (answer.body === null) {
      response.end();
      return;
    }
    const reader = answer.body.getReader();
    try {
      for (let read = await reader.read(); read.done === false; read = await reader.read()) {
        response.write(read.value);
      }
      response.end();
    } catch {
      // The worker left, or the model's answer broke off: the worker reads a cut stream either way.
      response.destroy();
    }
  });

  router.post(`/runs/:id${WorkerDoor.Tools}`, async (request: Request, response: WorkerResponse) => {
    const run = runOf(response);
    const parsed = routerToolCallSchema.safeParse(request.body);
    if (parsed.success === false) {
      const said = 'Send the router tool call: its server, tool, args and the model call it answers.';
      refuse(response, HttpStatus.BadRequest, ErrorCode.BadUserInput, said);
      return;
    }
    const { server, tool, args, call } = parsed.data;
    const isTarget = Object.values(run.assignment.targets).some(
      (target) => target.origin === TOOL_ORIGIN_ROUTER && target.server === server && target.tool === tool,
    );
    let answer: RouterToolAnswer;
    if (isTarget === false) {
      answer = { ok: false, error: `This run has no tool "${tool}" on server ${server}.` };
    } else {
      try {
        const text = await run.ports.callRouterTool(server, tool, args, {
          call,
          signal: requestSignal(response, run),
        });
        answer = { ok: true, text };
      } catch (error) {
        answer = { ok: false, error: errorMessage(error) };
      }
    }
    response.json(answer);
  });

  router.post(`/runs/:id${WorkerDoor.Events}`, (request: Request, response: WorkerResponse) => {
    const run = runOf(response);
    const parsed = eventBatchSchema.safeParse(request.body);
    const events = parsed.success ? parsed.data.events : [];
    const isLoops = parsed.success && events.every((event) => isLoopEvent(event));
    if (isLoops === false) {
      const said = 'Send the event batch: { events }, each one of the loop events agent-core names.';
      refuse(response, HttpStatus.BadRequest, ErrorCode.BadUserInput, said);
      return;
    }
    for (const event of events) {
      if (isLoopEvent(event)) {
        run.ports.publish(event);
      }
    }
    response.json({ ok: true });
  });

  router.post(`/runs/:id${WorkerDoor.Finish}`, (request: Request, response: WorkerResponse) => {
    const run = runOf(response);
    const outcome: unknown = request.body;
    if (isOutcome(outcome) === false) {
      const said =
        "Send the stretch's outcome: ok with its messages, usage, loaded, finishReason and handedBack, or an error.";
      refuse(response, HttpStatus.BadRequest, ErrorCode.BadUserInput, said);
      return;
    }
    run.finish(outcome);
    response.json({ ok: true });
  });

  router.use((_request: Request, response: Response) => {
    refuse(
      response,
      HttpStatus.NotFound,
      ErrorCode.NotFound,
      'The worker doors serve /channel, /hello and /runs/<id>/model, /tools/call, /events and /finish.',
    );
  });

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const type = isRecord(error) ? error.type : undefined;
    if (type === TOO_LARGE) {
      refuse(response, HttpStatus.PayloadTooLarge, ErrorCode.BadUserInput, `The body is over ${settings.bodyLimit}.`);
      return;
    }
    if (type === NOT_JSON) {
      refuse(response, HttpStatus.BadRequest, ErrorCode.BadUserInput, 'The body must be JSON.');
      return;
    }
    console.error(`[workers] a worker door failed: ${errorMessage(error)}`);
    if (response.headersSent) {
      response.end();
      return;
    }
    refuse(
      response,
      HttpStatus.InternalServerError,
      ErrorCode.Internal,
      'The router failed to answer. Its log says why.',
    );
  });

  return router;
}
