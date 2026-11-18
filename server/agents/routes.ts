import { createHash } from 'node:crypto';
import type { RunEvent } from '@cubicecho/agent-core';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { ConflictingKeysError } from '../auth/caller.ts';
import type { WorkspaceCaller } from '../core/context.ts';
import { RUN_DEFAULTS, type RunSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import type { SnapshotAgent, SnapshotHost } from '../db/snapshot.ts';
import { RunStatus } from '../db/tables/runs.ts';
import type { Forwarder } from '../models/forward.ts';
import { ModelFailure, openAiErrorBody } from '../models/openai-error.ts';
import { appCaller } from './app-caller.ts';
import { completionBody, openChunkStream, RUN_ID_HEADER } from './completion.ts';
import { agentLayer, resolveRun, UnreadableAgentError, withRouterFetch } from './layers.ts';
import { RequestRefusal, type RunRequest, readRunRequest, requestedAgent, requestedStream } from './request.ts';
import type { FinishedRun, Idempotency, RepeatedRun, RunService } from './run.ts';

/** The header a retry-safe request carries. */
const IDEMPOTENCY_HEADER = 'idempotency-key';
/** Who every agent on the list is owned by, in OpenAI's model list. */
const OWNER = 'ai-router';
/** The request fields a repeat may change and still be the same request. */
const DELIVERY_FIELDS: ReadonlySet<string> = new Set(['stream', 'stream_options']);
/** What body-parser calls a body over the limit, and one that isn't JSON. */
const TOO_LARGE = 'entity.too.large';
const NOT_JSON = 'entity.parse.failed';

/** What the agents endpoint talks to. */
export interface AgentRoutesDeps {
  snapshot: SnapshotHost;
  runs: RunService;
  forwarder: Forwarder;
  /** Settings that differ from `RUN_DEFAULTS`. */
  overrides?: Partial<RunSettings>;
  /** The clock keys' expiry is judged by. */
  now?: () => Date;
}

/** How an answer is delivered. */
interface Delivery {
  stream: boolean;
  includeUsage: boolean;
  /** The events a non-streamed answer carries as `ai_router.events`, when the app asked for progress. */
  events?: RunEvent[] | null;
}

/** A request that got past the key check: who it is from. */
interface AppLocals {
  caller: WorkspaceCaller;
}

/**
 * Answers in OpenAI's error envelope.
 *
 * @param response - The answer.
 * @param failure - What went wrong.
 * @param message - What the app is told.
 * @param [param] - The request field it is about.
 */
function refuse(response: Response, failure: ModelFailure, message: string, param: string | null = null): void {
  response.status(failure.status).json(openAiErrorBody(failure, message, param));
}

/**
 * Writes a JSON value with its keys in order, so two bodies that differ only in key order hash the same.
 *
 * @param value - Parsed JSON.
 * @returns The canonical text.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Hashes a request body for its `Idempotency-Key`, leaving out how the answer is delivered.
 *
 * @param body - The parsed body.
 * @returns Its SHA-256, in hex.
 */
function requestHash(body: unknown): string {
  const kept = isRecord(body)
    ? Object.fromEntries(Object.entries(body).filter(([field]) => DELIVERY_FIELDS.has(field) === false))
    : body;
  return createHash('sha256').update(canonicalJson(kept)).digest('hex');
}

/**
 * Finds the agent a workspace may run by its name.
 *
 * @param agents - The snapshot's agents.
 * @param workspaceId - The key's workspace.
 * @param name - The `model` the request names.
 * @returns The agent, or null when it doesn't exist, has no live revision, or isn't the workspace's to run.
 */
function runnableAgent(
  agents: ReadonlyMap<string, SnapshotAgent>,
  workspaceId: string,
  name: string | null,
): (SnapshotAgent & { document: Readonly<Record<string, unknown>> }) | null {
  const agent = name === null ? undefined : agents.get(name);
  if (agent === undefined || agent.workspaceIds.has(workspaceId) === false) {
    return null;
  }
  const { document } = agent;
  return agent.liveRevisionId === null || document === null ? null : { ...agent, document };
}

/**
 * Writes an agent's entry on the model list.
 *
 * @param agent - The agent.
 * @returns The entry, marked as an agent so an app's loop runs as a thin client.
 */
function modelEntry(agent: SnapshotAgent & { document: Readonly<Record<string, unknown>> }) {
  const { name, description } = agent.document;
  return {
    id: agent.name,
    object: 'model',
    created: 0,
    owned_by: OWNER,
    name: typeof name === 'string' ? name : agent.name,
    description: typeof description === 'string' ? description : '',
    ai_router: { kind: 'agent' },
  };
}

/**
 * Answers with how a run ended: its answer, or the error it ended with.
 *
 * @param response - The answer, with `X-Run-Id` set.
 * @param finished - The run.
 * @param delivery - Whether to stream, and with a usage chunk, and the events a non-streamed answer carries.
 * @param heartbeatSeconds - How often a quiet stream is sent a comment.
 */
function answerFinished(response: Response, finished: FinishedRun, delivery: Delivery, heartbeatSeconds: number): void {
  if (finished.status === RunStatus.Running) {
    refuse(response, ModelFailure.RunInProgress, 'That run is still going.');
    return;
  }
  if (finished.status === RunStatus.Cancelled) {
    refuse(response, ModelFailure.RunCancelled, `That run was cancelled: ${finished.error ?? ''}`);
    return;
  }
  if (finished.status === RunStatus.Failed) {
    refuse(response, ModelFailure.RunFailed, `The run failed: ${finished.error ?? ''}`);
    return;
  }
  if (delivery.stream === false) {
    response.json(completionBody(finished, delivery.events ?? null));
    return;
  }
  const meta = { runId: finished.runId, model: finished.agentName, startedAt: finished.startedAt };
  const stream = openChunkStream(response, meta, delivery.includeUsage, heartbeatSeconds);
  const content = finished.answer?.content ?? '';
  if (content !== '') {
    stream.text(content);
  }
  stream.end(finished);
}

/**
 * Builds the agents endpoint: `/v1/models` and `/v1/chat/completions`, for workspace keys only.
 *
 * @param deps - The snapshot, the run service and the forwarder.
 * @returns The router, to mount at `/v1`.
 */
export function createAgentRoutes({
  snapshot,
  runs,
  forwarder,
  overrides = {},
  now = () => new Date(),
}: AgentRoutesDeps): Router {
  const settings = { ...RUN_DEFAULTS, ...overrides };
  const { heartbeatSeconds } = settings;
  const router = express.Router();

  /**
   * Answers a request whose `Idempotency-Key` already started a run.
   *
   * @param response - The answer.
   * @param repeat - The run.
   * @param body - This request's body, for how to deliver the answer.
   */
  const answerRepeat = async (response: Response, repeat: RepeatedRun, body: unknown): Promise<void> => {
    response.setHeader(RUN_ID_HEADER, repeat.runId);
    if (repeat.matches === false) {
      refuse(
        response,
        ModelFailure.IdempotencyMismatch,
        'This Idempotency-Key already started a run with a different request. Send a new key for a new request.',
      );
      return;
    }
    answerFinished(response, await repeat.finished(), requestedStream(body), heartbeatSeconds);
  };

  router.use((request: Request, response: Response<unknown, AppLocals>, next: NextFunction) => {
    let caller: WorkspaceCaller | null;
    try {
      caller = appCaller(snapshot.current(), request, now());
    } catch (error) {
      if (error instanceof ConflictingKeysError) {
        refuse(response, ModelFailure.BadRequest, error.message);
        return;
      }
      throw error;
    }
    if (caller === null) {
      refuse(response, ModelFailure.Unauthenticated, 'Send a workspace key as Authorization: Bearer, or x-api-key.');
      return;
    }
    response.locals.caller = caller;
    next();
  });
  router.use(express.json({ limit: settings.bodyLimit }));

  router.get('/models', (_request: Request, response: Response<unknown, AppLocals>) => {
    const { workspaceId } = response.locals.caller;
    const { agents } = snapshot.current();
    const data = [...agents.values()].flatMap((agent) => {
      const runnable = runnableAgent(agents, workspaceId, agent.name);
      return runnable === null ? [] : [modelEntry(runnable)];
    });
    response.json({ object: 'list', data });
  });

  router.get('/models/:id', (request: Request<{ id: string }>, response: Response<unknown, AppLocals>) => {
    const agent = runnableAgent(snapshot.current().agents, response.locals.caller.workspaceId, request.params.id);
    if (agent === null) {
      refuse(response, ModelFailure.ModelNotFound, `There is no agent named "${request.params.id}" for this key.`);
      return;
    }
    response.json(modelEntry(agent));
  });

  router.post('/chat/completions', async (request: Request, response: Response<unknown, AppLocals>) => {
    const { workspaceId } = response.locals.caller;
    const body: unknown = request.body;
    const keyHeader = request.get(IDEMPOTENCY_HEADER);
    let idempotency: Idempotency | null = null;
    if (keyHeader !== undefined) {
      const key = keyHeader.trim();
      const isUsable = key !== '' && key.length <= settings.maxIdempotencyKeyLength;
      if (isUsable === false) {
        const limit = settings.maxIdempotencyKeyLength;
        refuse(response, ModelFailure.BadRequest, `Idempotency-Key: send 1 to ${limit} characters.`, 'Idempotency-Key');
        return;
      }
      idempotency = { key, hash: requestHash(body) };
      const repeat = await runs.repeatOf(workspaceId, idempotency);
      if (repeat !== null) {
        await answerRepeat(response, repeat, body);
        return;
      }
    }
    const current = snapshot.current();
    const workspace = current.workspaces.get(workspaceId);
    const name = requestedAgent(body);
    const agent = runnableAgent(current.agents, workspaceId, name);
    if (agent === null || workspace === undefined) {
      const message = name === null ? 'Name an agent as the model.' : `There is no agent named "${name}" for this key.`;
      refuse(response, ModelFailure.ModelNotFound, message, 'model');
      return;
    }
    let started: Awaited<ReturnType<RunService['begin']>>;
    let delivery: RunRequest;
    try {
      const runRequest = readRunRequest(body, agent.policy);
      delivery = runRequest;
      const resolved = resolveRun(agentLayer(agent.name, agent.document), runRequest, current);
      const fetch = forwarder.fetchFor({
        workspaceId,
        workspaceName: workspace.slug,
        agentId: agent.id,
        agentName: agent.name,
      });
      const config = withRouterFetch(resolved, fetch);
      started = await runs.begin({ workspace, agent, request: runRequest, config, idempotency });
    } catch (error) {
      if (error instanceof RequestRefusal) {
        refuse(response, ModelFailure.BadRequest, error.message, error.param);
        return;
      }
      if (error instanceof UnreadableAgentError) {
        console.error(`[runs] ${error.message}`);
        refuse(response, ModelFailure.RunFailed, error.message);
        return;
      }
      throw error;
    }
    if (started.kind === 'repeated') {
      await answerRepeat(response, started, body);
      return;
    }
    response.setHeader(RUN_ID_HEADER, started.runId);
    // A run without a key ends with its connection. One with a key goes on to its timeout, so the retry the key
    // is for finds the answer rather than a cancellation.
    const disconnected = new AbortController();
    response.on('close', () => {
      if (response.writableFinished === false && idempotency === null) {
        disconnected.abort();
      }
    });
    if (delivery.stream === false) {
      const events: RunEvent[] = [];
      const listener = { onText: () => {}, onEvent: (event: RunEvent) => events.push(event) };
      const finished = await started.execute(listener, disconnected.signal);
      answerFinished(response, finished, { ...delivery, events: delivery.progress ? events : null }, heartbeatSeconds);
      return;
    }
    const meta = { runId: started.runId, model: agent.name, startedAt: started.startedAt };
    const stream = openChunkStream(response, meta, delivery.includeUsage, heartbeatSeconds);
    const listener = {
      onText: (text: string) => stream.text(text),
      onEvent: (event: RunEvent) => {
        if (delivery.progress) {
          stream.event(event);
        }
      },
    };
    const finished = await started.execute(listener, disconnected.signal);
    if (finished.status === RunStatus.Completed) {
      stream.end(finished);
    } else {
      const isCancelled = finished.status === RunStatus.Cancelled;
      const failure = isCancelled ? ModelFailure.RunCancelled : ModelFailure.RunFailed;
      const said = isCancelled ? 'The run was cancelled' : 'The run failed';
      stream.fail(openAiErrorBody(failure, `${said}: ${finished.error ?? ''}`));
    }
  });

  router.use((request: Request, response: Response) => {
    refuse(
      response,
      ModelFailure.NotFound,
      `The agents endpoint has no ${request.method} ${request.baseUrl}${request.path}. It serves models and chat/completions.`,
    );
  });

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const type = isRecord(error) ? error.type : undefined;
    if (type === TOO_LARGE) {
      refuse(response, ModelFailure.PayloadTooLarge, `The body is over ${settings.bodyLimit}.`);
      return;
    }
    if (type === NOT_JSON) {
      refuse(response, ModelFailure.BadRequest, 'The body must be JSON.');
      return;
    }
    console.error(`[runs] the agents endpoint failed: ${errorMessage(error)}`);
    if (response.headersSent) {
      response.end();
      return;
    }
    refuse(response, ModelFailure.RunFailed, 'The router failed to answer. Its log says why.');
  });

  return router;
}
