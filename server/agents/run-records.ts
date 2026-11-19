import { and, desc, eq } from 'drizzle-orm';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { ConflictingKeysError } from '../auth/caller.ts';
import type { WorkspaceCaller } from '../core/context.ts';
import { CONVERSATION_DEFAULTS, RUN_DEFAULTS, type RunSettings } from '../core/defaults.ts';
import { ErrorCode, errorMessage } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import { HttpStatus } from '../core/wire.ts';
import type { DB } from '../db/client.ts';
import type { SnapshotHost } from '../db/snapshot.ts';
import { conversations } from '../db/tables/conversations.ts';
import { type RunRow, runs } from '../db/tables/runs.ts';
import { appCaller } from './app-caller.ts';
import { openEventStream } from './completion.ts';
import { NOT_JSON, TOO_LARGE } from './routes.ts';
import type { RunService } from './run.ts';

/** The header an event stream client sends back on reconnecting: the `seq` of the last event it has. */
const LAST_EVENT_ID = 'last-event-id';
/** What asks for a live event stream rather than JSON. */
const EVENT_STREAM = 'text/event-stream';
/** Why a run an app cancelled without saying why ended. */
export const APP_CANCELLED = 'The app cancelled the run.';

/** A run id, before it is looked up. */
const runIdSchema = z.uuid();
/** The `seq` a reader already has. */
const afterSchema = z.coerce.number().int().min(0);
/** What `GET /runs` takes: one session's runs, and how many. */
const listSchema = z.object({
  session: z.string().trim().min(1).max(CONVERSATION_DEFAULTS.maxIdLength).optional(),
  limit: z.coerce.number().int().min(1).max(RUN_DEFAULTS.maxRunPageSize).default(RUN_DEFAULTS.runPageSize),
});
/** A cancel's body, which may be left out: why, as the run's error says it. */
const cancelSchema = z
  .object({ reason: z.string().trim().min(1).max(RUN_DEFAULTS.maxErrorLength).optional() })
  .optional();

/** What the run records talk to. */
export interface RunRecordRoutesDeps {
  db: DB;
  snapshot: SnapshotHost;
  /** The runs, for their events and to cancel them. */
  runs: RunService;
  /** Settings that differ from `RUN_DEFAULTS`. */
  overrides?: Partial<RunSettings>;
  /** The clock keys' expiry is judged by. */
  now?: () => Date;
}

/** A request that got past the key check: who it is from. */
interface AppLocals {
  caller: WorkspaceCaller;
}

/**
 * Answers in the `/runs` error format, with the codes GraphQL uses.
 *
 * @param response - The answer.
 * @param status - The HTTP status.
 * @param code - The code.
 * @param error - What the app is told.
 */
function refuse(response: Response, status: HttpStatus, code: ErrorCode, error: string): void {
  response.status(status).json({ error, code });
}

/**
 * Writes a run's record as `/runs/<id>` serves it.
 *
 * @param row - The run.
 * @param conversation - The app's name for the conversation it belongs to, or null.
 * @returns Its agent, revision, conversation, session, status, what its requests added, timings (when it started, last
 * began waiting, and ended), usage and error.
 */
export function runRecord(row: RunRow, conversation: string | null) {
  return {
    id: row.id,
    conversation,
    session: row.sessionKey,
    agent: row.agentName,
    agentId: row.agentId,
    revisionId: row.revisionId,
    workspace: row.workspaceName,
    status: row.status,
    input: row.input,
    user: row.user,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    waitingSince: row.waitingSince?.toISOString() ?? null,
    usage: {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.inputTokens + row.outputTokens,
    },
    error: row.error,
  };
}

/**
 * Builds the run records: `GET /runs`, `/runs/<id>`, `/runs/<id>/events` and `POST /runs/<id>/cancel`, for workspace
 * keys only, each its own workspace's.
 *
 * @param deps - The database, the snapshot and the run service.
 * @returns The router, to mount at `/runs`.
 */
export function createRunRecordRoutes({
  db,
  snapshot,
  runs: runService,
  overrides = {},
  now = () => new Date(),
}: RunRecordRoutesDeps): Router {
  const { heartbeatSeconds, bodyLimit } = { ...RUN_DEFAULTS, ...overrides };
  const { bus } = runService;
  const router = express.Router();

  /**
   * Finds a run of the caller's workspace.
   *
   * @param response - The answer, refused with 404 when there is no such run.
   * @param id - The id in the path.
   * @returns The run and its conversation's name, or null once refused.
   */
  const ownRun = async (
    response: Response<unknown, AppLocals>,
    id: string,
  ): Promise<{ run: RunRow; conversation: string | null } | null> => {
    const isId = runIdSchema.safeParse(id).success;
    const [row] = isId
      ? await db
          .select({ run: runs, conversation: conversations.key })
          .from(runs)
          .leftJoin(conversations, eq(conversations.id, runs.conversationId))
          .where(and(eq(runs.id, id), eq(runs.workspaceId, response.locals.caller.workspaceId)))
      : [];
    if (row === undefined) {
      // Another workspace's run is as missing as one that never was.
      refuse(response, HttpStatus.NotFound, ErrorCode.NotFound, 'There is no run with that id for this key.');
      return null;
    }
    return row;
  };

  router.use((request: Request, response: Response<unknown, AppLocals>, next: NextFunction) => {
    let caller: WorkspaceCaller | null;
    try {
      caller = appCaller(snapshot.current(), request, now());
    } catch (error) {
      if (error instanceof ConflictingKeysError) {
        refuse(response, HttpStatus.BadRequest, ErrorCode.BadUserInput, error.message);
        return;
      }
      throw error;
    }
    if (caller === null) {
      const said = 'Send a workspace key as Authorization: Bearer, or x-api-key.';
      refuse(response, HttpStatus.Unauthorized, ErrorCode.Unauthenticated, said);
      return;
    }
    response.locals.caller = caller;
    next();
  });

  router.get('/', async (request: Request, response: Response<unknown, AppLocals>) => {
    const parsed = listSchema.safeParse(request.query);
    if (parsed.success === false) {
      const said = `session is a session's key, and limit 1 to ${RUN_DEFAULTS.maxRunPageSize} runs. Both may be left out.`;
      refuse(response, HttpStatus.BadRequest, ErrorCode.BadUserInput, said);
      return;
    }
    const { session, limit } = parsed.data;
    const ofWorkspace = eq(runs.workspaceId, response.locals.caller.workspaceId);
    const rows = await db
      .select({ run: runs, conversation: conversations.key })
      .from(runs)
      .leftJoin(conversations, eq(conversations.id, runs.conversationId))
      .where(session === undefined ? ofWorkspace : and(ofWorkspace, eq(runs.sessionKey, session)))
      .orderBy(desc(runs.startedAt), desc(runs.id))
      .limit(limit);
    response.json({ runs: rows.map((row) => runRecord(row.run, row.conversation)) });
  });

  router.get('/:id', async (request: Request<{ id: string }>, response: Response<unknown, AppLocals>) => {
    const found = await ownRun(response, request.params.id);
    if (found !== null) {
      response.json(runRecord(found.run, found.conversation));
    }
  });

  router.get('/:id/events', async (request: Request<{ id: string }>, response: Response<unknown, AppLocals>) => {
    const after = request.get(LAST_EVENT_ID) ?? request.query.after ?? 0;
    const parsed = afterSchema.safeParse(after);
    if (parsed.success === false) {
      const said = 'after (or Last-Event-ID) is the seq of the last event you have: a whole number, 0 or more.';
      refuse(response, HttpStatus.BadRequest, ErrorCode.BadUserInput, said);
      return;
    }
    const row = (await ownRun(response, request.params.id))?.run;
    if (row === undefined) {
      return;
    }
    const afterSeq = parsed.data;
    const isLive = request.get('accept')?.includes(EVENT_STREAM) === true;
    if (isLive === false) {
      response.json({ runId: row.id, events: await bus.events(row.id, afterSeq) });
      return;
    }
    const left = new AbortController();
    response.on('close', () => left.abort());
    const stream = openEventStream(response, heartbeatSeconds);
    for await (const event of bus.watch(row.id, { afterSeq, signal: left.signal })) {
      stream.send(event, event.seq);
    }
    stream.close();
  });

  router.post(
    '/:id/cancel',
    express.json({ limit: bodyLimit }),
    async (request: Request<{ id: string }>, response: Response<unknown, AppLocals>) => {
      const parsed = cancelSchema.safeParse(request.body);
      if (parsed.success === false) {
        const said = `reason: send 1 to ${RUN_DEFAULTS.maxErrorLength} characters, or leave it out.`;
        refuse(response, HttpStatus.BadRequest, ErrorCode.BadUserInput, said);
        return;
      }
      const found = await ownRun(response, request.params.id);
      if (found === null) {
        return;
      }
      const cancelled = await runService.cancel(found.run.id, parsed.data?.reason ?? APP_CANCELLED);
      response.json(runRecord(cancelled ?? found.run, found.conversation));
    },
  );

  router.use((_request: Request, response: Response) => {
    refuse(
      response,
      HttpStatus.NotFound,
      ErrorCode.NotFound,
      'The run records serve /runs, /runs/<id>, /runs/<id>/events and POST /runs/<id>/cancel.',
    );
  });

  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const type = isRecord(error) ? error.type : undefined;
    if (type === TOO_LARGE) {
      refuse(response, HttpStatus.PayloadTooLarge, ErrorCode.BadUserInput, `The body is over ${bodyLimit}.`);
      return;
    }
    if (type === NOT_JSON) {
      refuse(response, HttpStatus.BadRequest, ErrorCode.BadUserInput, 'The body must be JSON.');
      return;
    }
    console.error(`[runs] the run records failed: ${errorMessage(error)}`);
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
