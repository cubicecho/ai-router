import type { RunEvent } from '@cubicecho/agent-core';
import type { Response } from 'express';
import { HttpStatus, MS_PER_SECOND } from '../core/wire.ts';
import type { OpenAiErrorBody } from '../models/openai-error.ts';
import type { FinishedRun } from './run.ts';

/** The header every agent answer names its run in, once there is one. */
export const RUN_ID_HEADER = 'X-Run-Id';

/** The content type of a server-sent event stream. */
const EVENT_STREAM_TYPE = 'text/event-stream';
/** What ends an OpenAI stream. */
const STREAM_END = '[DONE]';
/** A comment line, which every SSE client skips. */
const HEARTBEAT = ': keep-alive\n\n';

/** What every completion and chunk of one run says about it. */
export interface CompletionMeta {
  runId: string;
  /** The agent's name, which the app asked for as its model. */
  model: string;
  startedAt: Date;
}

/** OpenAI's token counts, from a run's. */
interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * Names a run's completion as OpenAI names one.
 *
 * @param meta - The run.
 * @returns The id, the model and the creation time in seconds.
 */
function header(meta: CompletionMeta): { id: string; created: number; model: string } {
  return {
    id: `chatcmpl-${meta.runId}`,
    created: Math.floor(meta.startedAt.getTime() / MS_PER_SECOND),
    model: meta.model,
  };
}

/**
 * Reads a run's token counts in OpenAI's words.
 *
 * @param finished - The run.
 * @returns The counts.
 */
function usageOf(finished: FinishedRun): CompletionUsage {
  return {
    prompt_tokens: finished.inputTokens,
    completion_tokens: finished.outputTokens,
    total_tokens: finished.inputTokens + finished.outputTokens,
  };
}

/**
 * Builds the non-streamed answer of a completed run.
 *
 * @param finished - The run. It completed, so it has an answer.
 * @param [events] - Its events, when the app asked for progress: they go beside `choices`, as `ai_router.events`.
 * @returns A `chat.completion`.
 */
export function completionBody(finished: FinishedRun, events: RunEvent[] | null = null) {
  const meta = { runId: finished.runId, model: finished.agentName, startedAt: finished.startedAt };
  return {
    ...(events === null ? {} : { ai_router: { runId: finished.runId, events } }),
    ...header(meta),
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: finished.answer?.content ?? '' },
        finish_reason: finished.answer?.finishReason ?? 'stop',
      },
    ],
    usage: usageOf(finished),
  };
}

/** Writes a run's answer to the app as OpenAI's `chat.completion.chunk` stream. */
export interface ChunkStream {
  /**
   * Sends the answer's text so far.
   *
   * @param content - What arrived.
   */
  text(content: string): void;
  /**
   * Sends one of the run's events as a progress chunk: empty `choices`, so a standard client skips it, and the event
   * as `ai_router.event`.
   *
   * @param event - The event.
   */
  event(event: RunEvent): void;
  /**
   * Ends a run that completed: the finish chunk, the usage chunk when asked for, and `[DONE]`.
   *
   * @param finished - The run.
   */
  end(finished: FinishedRun): void;
  /**
   * Ends a run that didn't complete, with an error the OpenAI client reads as one.
   *
   * @param error - The error.
   */
  fail(error: OpenAiErrorBody): void;
}

/** A server-sent event stream on an answer. */
export interface EventStream {
  /**
   * Sends one `data:` line.
   *
   * @param data - Text as it is, or a value written as JSON.
   * @param [id] - The event's `id:`, which a client that reconnects sends back as `Last-Event-ID`.
   */
  send(data: unknown, id?: number): void;
  /** Ends the stream, unless the client already left. */
  close(): void;
  /** Whether the client is gone or the stream has ended. */
  isGone(): boolean;
}

/**
 * Opens a server-sent event stream on an answer, with its headers sent at once, and a comment while it is quiet.
 *
 * @param response - The Express answer, with any headers of its own already set.
 * @param heartbeatSeconds - How often a quiet stream is sent a comment, so a proxy doesn't close it.
 * @returns The stream.
 */
export function openEventStream(response: Response, heartbeatSeconds: number): EventStream {
  response.status(HttpStatus.Ok);
  response.setHeader('content-type', EVENT_STREAM_TYPE);
  response.setHeader('cache-control', 'no-cache');
  response.setHeader('x-accel-buffering', 'no');
  response.flushHeaders();
  // A run with an Idempotency-Key outlives its connection, so what it says after the app has gone goes nowhere.
  const isGone = (): boolean => response.destroyed || response.writableEnded;
  const write = (text: string): void => {
    if (isGone() === false) {
      response.write(text);
    }
  };
  const heartbeat = setInterval(() => write(HEARTBEAT), heartbeatSeconds * MS_PER_SECOND);
  heartbeat.unref();
  response.on('close', () => clearInterval(heartbeat));
  return {
    send: (data, id) => {
      const line = `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
      write(id === undefined ? line : `id: ${id}\n${line}`);
    },
    close: () => {
      clearInterval(heartbeat);
      if (isGone() === false) {
        response.end();
      }
    },
    isGone,
  };
}

/**
 * Opens an event stream on the answer, with its headers sent at once so the app has the run id from the start.
 *
 * @param response - The Express answer. `X-Run-Id` is already set on it.
 * @param meta - The run.
 * @param includeUsage - Whether the stream ends with a usage chunk, as `stream_options.include_usage` asks.
 * @param heartbeatSeconds - How often a quiet stream is sent a comment.
 * @returns The stream.
 */
export function openChunkStream(
  response: Response,
  meta: CompletionMeta,
  includeUsage: boolean,
  heartbeatSeconds: number,
): ChunkStream {
  const { send, close } = openEventStream(response, heartbeatSeconds);
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
    ...header(meta),
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  send(chunk({ role: 'assistant', content: '' }, null));
  return {
    text: (content) => send(chunk({ content }, null)),
    event: (event) => send({ ...header(meta), object: 'chat.completion.chunk', choices: [], ai_router: { event } }),
    end: (finished) => {
      send(chunk({}, finished.answer?.finishReason ?? 'stop'));
      if (includeUsage) {
        send({ ...header(meta), object: 'chat.completion.chunk', choices: [], usage: usageOf(finished) });
      }
      send(STREAM_END);
      close();
    },
    fail: (error) => {
      send(error);
      close();
    },
  };
}
