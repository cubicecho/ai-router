import { createHash } from 'node:crypto';
import type { RunEvent } from '@cubicecho/agent-core';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { ConflictingKeysError } from '../auth/caller.ts';
import type { WorkspaceCaller } from '../core/context.ts';
import { RUN_DEFAULTS, type RunSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import type { Snapshot, SnapshotHost } from '../db/snapshot.ts';
import type { RunResume } from '../db/tables/runs.ts';
import { RunStatus } from '../db/tables/runs.ts';
import { SESSION_HEADER } from '../models/affinity.ts';
import type { ModelCatalog } from '../models/catalog.ts';
import type { Forwarder } from '../models/forward.ts';
import { ModelFailure, openAiErrorBody } from '../models/openai-error.ts';
import { appCaller } from './app-caller.ts';
import { completionBody, HEADER_LIST_JOIN, openChunkStream, PRUNED_TOOLS_HEADER, RUN_ID_HEADER } from './completion.ts';
import { agentContextLength } from './context-length.ts';
import { CONVERSATION_HEADER, readConversationKey } from './conversation.ts';
import { agentLayer, resolveRun, UnreadableAgentError, withRouterFetch } from './layers.ts';
import {
  IGNORED_HEADER,
  ignoredHeaderValue,
  RequestRefusal,
  type RunRequest,
  readRunRequest,
  requestedAgent,
  requestedStream,
} from './request.ts';
import { type FinishedRun, type Idempotency, type RepeatedRun, RunConflict, type RunService } from './run.ts';
import { readSessionKey } from './session.ts';
import { beginRun, type RunnableAgent, runnableAgent, runnableAgents } from './start.ts';

/** The header a retry-safe request carries. */
const IDEMPOTENCY_HEADER = 'idempotency-key';
/** Who every agent on the list is owned by, in OpenAI's model list. */
const OWNER = 'ai-router';
/** The request fields a repeat may change and still be the same request. */
const DELIVERY_FIELDS: ReadonlySet<string> = new Set(['stream', 'stream_options']);
/** What body-parser calls a body over the limit, and one that isn't JSON. */
export const TOO_LARGE = 'entity.too.large';
export const NOT_JSON = 'entity.parse.failed';

/** What the agents endpoint talks to. */
export interface AgentRoutesDeps {
  snapshot: SnapshotHost;
  runs: RunService;
  forwarder: Forwarder;
  /** The providers' model lists, for each agent's context length. */
  catalog: ModelCatalog;
  /** Settings that differ from `RUN_DEFAULTS`. */
  overrides?: Partial<RunSettings>;
  /** The clock keys' expiry is judged by. */
  now?: () => Date;
}

/** How a run that has no answer for the app is told, by its status. A completed or waiting run has one. */
const UNANSWERED: Partial<Record<RunStatus, { failure: ModelFailure; said: string }>> = {
  [RunStatus.Running]: { failure: ModelFailure.RunInProgress, said: 'That run is still going' },
  [RunStatus.Cancelled]: { failure: ModelFailure.RunCancelled, said: 'The run was cancelled' },
  [RunStatus.Failed]: { failure: ModelFailure.RunFailed, said: 'The run failed' },
  [RunStatus.Expired]: { failure: ModelFailure.RunExpired, said: 'The run expired' },
};

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
 * Writes an agent's entry on the model list.
 *
 * @param agent - The agent.
 * @param contextLength - How many tokens its model reads, or null when that isn't known.
 * @returns The entry, marked as an agent so an app's loop runs as a thin client, with `context_length` when known.
 */
function modelEntry(agent: RunnableAgent, contextLength: number | null) {
  const { name, description } = agent.document;
  return {
    id: agent.name,
    object: 'model',
    created: 0,
    owned_by: OWNER,
    name: typeof name === 'string' ? name : agent.name,
    description: typeof description === 'string' ? description : '',
    ...(contextLength === null ? {} : { context_length: contextLength }),
    ai_router: { kind: 'agent' },
  };
}

/**
 * The layers a resumed run carries on with: its own, which a resume may repeat but never change.
 *
 * @param request - The request that answers the run.
 * @param resume - What the run kept.
 * @returns The request, with the run's own host, task, servers and sampling.
 * @throws {@link RequestRefusal} When the request sends host or task text other than the run's.
 */
function resumedLayers(request: RunRequest, resume: RunResume): RunRequest {
  const isOtherHost = request.hostText !== null && request.hostText !== resume.hostText;
  if (isOtherHost) {
    throw new RequestRefusal(
      'messages',
      'messages: the run being answered keeps the system messages it started with, and these differ. Send the same ones, or none.',
    );
  }
  const isOtherTask = request.taskText !== null && request.taskText !== resume.taskText;
  if (isOtherTask) {
    throw new RequestRefusal(
      'ai_router.task',
      'ai_router.task: the run being answered keeps the task it started with, and this differs. Send the same one, or none.',
    );
  }
  const { hostText, taskText, servers, sampling } = resume;
  return { ...request, hostText, taskText, servers, sampling };
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
  const refusal = UNANSWERED[finished.status];
  if (refusal !== undefined) {
    refuse(response, refusal.failure, `${refusal.said}${finished.error === null ? '' : `: ${finished.error}`}`);
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
  catalog,
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

  /**
   * Writes an agent's entry with its context length, waiting at most `modelListWaitMs` for a provider's listing.
   *
   * @param agent - A runnable agent.
   * @param current - The snapshot the request reads.
   * @returns The entry.
   */
  const entryOf = async (agent: RunnableAgent, current: Snapshot) =>
    modelEntry(agent, await agentContextLength(agent.name, agent.document, current, catalog));

  router.get('/models', async (_request: Request, response: Response<unknown, AppLocals>) => {
    const current = snapshot.current();
    const runnable = runnableAgents(current, response.locals.caller.workspaceId);
    const data = await Promise.all(runnable.map((agent) => entryOf(agent, current)));
    response.json({ object: 'list', data });
  });

  router.get('/models/:id', async (request: Request<{ id: string }>, response: Response<unknown, AppLocals>) => {
    const { id } = request.params;
    const current = snapshot.current();
    const agent = runnableAgent(current.agents, response.locals.caller.workspaceId, id);
    if (agent === null) {
      // The same answer as for a chat request that names it, so a probe can't tell an ungranted agent apart.
      refuse(response, ModelFailure.ModelNotFound, `There is no agent named "${id}" for this key.`, 'model');
      return;
    }
    response.json(await entryOf(agent, current));
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
      const runRequest = readRunRequest(body, agent.policy, current.settings);
      delivery = runRequest;
      // Before the first byte, so a streamed answer carries it too.
      const ignored = ignoredHeaderValue(runRequest.ignored);
      if (ignored !== null) {
        response.setHeader(IGNORED_HEADER, ignored);
      }
      const conversationKey = readConversationKey(request.get(CONVERSATION_HEADER));
      const sessionKey = readSessionKey(conversationKey, request.get(SESSION_HEADER));
      const conversation =
        conversationKey === null ? null : await runs.openConversation(workspaceId, agent, conversationKey);
      if (runRequest.answers.length > 0) {
        // Tool messages at the end answer a run that handed calls back: that same run carries on.
        const waiting = await runs.waitingFor(workspaceId, agent.id, runRequest.answers);
        const isOtherConversation = conversation !== null && waiting.conversationId !== conversation.id;
        if (isOtherConversation) {
          throw new RequestRefusal(
            CONVERSATION_HEADER,
            `${CONVERSATION_HEADER}: the tool messages answer a run of another conversation, or of none.`,
          );
        }
        const layers = resumedLayers(runRequest, waiting.resume);
        const resolved = resolveRun(agentLayer(agent.name, waiting.document), layers, current);
        const fetch = forwarder.fetchFor({
          workspaceId,
          workspaceName: workspace.slug,
          agentId: agent.id,
          agentName: agent.name,
        });
        const config = withRouterFetch(resolved, fetch);
        const input = { workspace, agent, request: runRequest, config, idempotency, conversation, sessionKey };
        started = await runs.resume(input, waiting);
      } else {
        started = await beginRun(runs, forwarder, current, {
          workspace,
          agent,
          request: runRequest,
          conversation,
          sessionKey,
          idempotency,
        });
      }
    } catch (error) {
      if (error instanceof RequestRefusal) {
        refuse(response, ModelFailure.BadRequest, error.message, error.param);
        return;
      }
      if (error instanceof RunConflict) {
        refuse(response, error.failure, error.message);
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
    if (started.prunedTools.length > 0) {
      response.setHeader(PRUNED_TOOLS_HEADER, started.prunedTools.join(HEADER_LIST_JOIN));
    }
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
    const refusal = UNANSWERED[finished.status];
    if (refusal === undefined) {
      stream.end(finished);
    } else {
      stream.fail(openAiErrorBody(refusal.failure, `${refusal.said}: ${finished.error ?? ''}`));
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
