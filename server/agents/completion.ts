import {
  isNested,
  progressChunk,
  type RunEvent,
  RunEventKind,
  type StackWarning,
  withProgress,
} from '@cubicecho/agent-core';
import type { Response } from 'express';
import { HttpStatus, MS_PER_SECOND } from '../core/wire.ts';
import type { OpenAiErrorBody } from '../models/openai-error.ts';
import { AGENT_CORE_FIELD } from './request.ts';
import type { FinishedRun } from './run.ts';

/** The header every agent answer names its run in, once there is one. */
export const RUN_ID_HEADER = 'X-Run-Id';
/** The header that names the app tools a run left out, because the agent's own tools answer them. */
export const PRUNED_TOOLS_HEADER = 'X-AI-Router-Pruned-Tools';
/** What joins the names in a header that lists several. */
export const HEADER_LIST_JOIN = ', ';

/** The content type of a server-sent event stream. */
const EVENT_STREAM_TYPE = 'text/event-stream';
/** What ends an OpenAI stream. */
const STREAM_END = '[DONE]';
/** A comment line, which every SSE client skips. */
const HEARTBEAT = ': keep-alive\n\n';
/** What sets a line about a tool apart from the reasoning around it. */
const REASONING_BREAK = '\n\n';

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
 * Builds the assistant message of a run's answer.
 *
 * @param finished - The run.
 * @returns Its text, and the app tool calls a waiting run hands back. A message with calls and no text has null
 * content, as OpenAI writes one.
 */
function messageOf(finished: FinishedRun) {
  const content = finished.answer?.content ?? '';
  const toolCalls = finished.answer?.toolCalls ?? [];
  if (toolCalls.length === 0) {
    return { role: 'assistant', content };
  }
  return { role: 'assistant', content: content === '' ? null : content, tool_calls: toolCalls };
}

/**
 * Writes the app's parts a run dropped as the answer's `agent_core.warnings`.
 *
 * @param warnings - The parts, from `StartedRun.warnings`.
 * @returns The field to spread into a body or chunk, or nothing when there are none.
 */
function warningsField(warnings: readonly StackWarning[]): { [AGENT_CORE_FIELD]?: { warnings: StackWarning[] } } {
  return warnings.length === 0 ? {} : { [AGENT_CORE_FIELD]: { warnings: [...warnings] } };
}

/**
 * Says what a run's event is in the words a chat client shows as a model's reasoning.
 *
 * @param event - The event.
 * @returns The scratchpad's text as it streams, a line for a tool called or come back, or null for any other event
 * and for one from a run this one called.
 */
export function reasoningText(event: RunEvent): string | null {
  if (isNested(event)) {
    return null;
  }
  if (event.kind === RunEventKind.Thinking) {
    return event.text;
  }
  if (event.kind === RunEventKind.ToolCall) {
    return `${REASONING_BREAK}Calling \`${event.name}\`…${REASONING_BREAK}`;
  }
  if (event.kind === RunEventKind.ToolResult) {
    const said = event.ok === false ? 'failed' : 'came back';
    return `${REASONING_BREAK}\`${event.name}\` ${said}.${REASONING_BREAK}`;
  }
  return null;
}

/**
 * Builds the non-streamed answer of a completed or waiting run.
 *
 * @param finished - The run. It completed or waits, so it has an answer.
 * @param [events] - Its events, when the app asked for progress: they go beside `choices`, as `agent_core.events`.
 * @param [warnings] - The app's parts the run dropped, beside `choices` as `agent_core.warnings`.
 * @returns A `chat.completion`.
 */
export function completionBody(
  finished: FinishedRun,
  events: RunEvent[] | null = null,
  warnings: readonly StackWarning[] = [],
) {
  const meta = { runId: finished.runId, model: finished.agentName, startedAt: finished.startedAt };
  const completion = {
    ...header(meta),
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message: messageOf(finished),
        finish_reason: finished.answer?.finishReason ?? 'stop',
      },
    ],
    usage: usageOf(finished),
  };
  const warned = { ...completion, ...warningsField(warnings) };
  if (events === null) {
    return warned;
  }
  // agent-core's own encoder, so what min-agent and task_server decode can't drift from what is sent.
  const withEvents = withProgress(completion, finished.runId, events);
  return { ...withEvents, [AGENT_CORE_FIELD]: { ...withEvents[AGENT_CORE_FIELD], ...warned[AGENT_CORE_FIELD] } };
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
   * Sends the run's work as reasoning so far, in `delta.reasoning_content`, which chat clients fold away above the
   * answer.
   *
   * @param content - What `reasoningText` wrote.
   */
  reasoning(content: string): void;
  /**
   * Sends one of the run's events as a progress chunk: empty `choices`, so a standard client skips it, and the event
   * as `agent_core.event`.
   *
   * @param event - The event.
   */
  event(event: RunEvent): void;
  /**
   * Ends a run that completed or waits: the calls it hands back, the finish chunk, the usage chunk when asked for,
   * and `[DONE]`.
   *
   * @param finished - The run.
   * @param [warnings] - The app's parts the run dropped, on the finish chunk as `agent_core.warnings`.
   */
  end(finished: FinishedRun, warnings?: readonly StackWarning[]): void;
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
    reasoning: (content) => send(chunk({ reasoning_content: content }, null)),
    event: (event) => send(progressChunk(event, header(meta))),
    end: (finished, warnings = []) => {
      const toolCalls = (finished.answer?.toolCalls ?? []).map((call, index) => ({ index, ...call }));
      if (toolCalls.length > 0) {
        send(chunk({ tool_calls: toolCalls }, null));
      }
      send({ ...chunk({}, finished.answer?.finishReason ?? 'stop'), ...warningsField(warnings) });
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
