import { setTimeout as delay } from 'node:timers/promises';
import { EventSourceParserStream } from 'eventsource-parser/stream';
import { z } from 'zod';
import { WORKER_DEFAULTS, type WorkerSettings } from '../server/core/defaults.ts';
import { errorMessage } from '../server/core/errors.ts';
import { MS_PER_SECOND } from '../server/core/wire.ts';
import type { RunAssignment } from '../server/runner/assignment.ts';
import { type ChannelMessage, ChannelMessageType, WORKERS_PATH, WorkerDoor } from '../server/runner/protocol.ts';
import { WORKER_PROGRAM_DEFAULTS, type WorkerProgramSettings } from './defaults.ts';

/** What the channel asks the router for. */
const EVENT_STREAM = 'text/event-stream';
/** What each failed dial multiplies the wait before the next by. */
const BACKOFF_FACTOR = 2;
/** Why a cancel stopped a run when the router gave no reason. */
const NO_REASON = 'cancelled by the router';

/** An `assign` event's data: the assignment, its run named. */
const assignDataSchema = z.looseObject({ assignment: z.looseObject({ runId: z.string().min(1) }) });
/** A `cancel` event's data. */
const cancelDataSchema = z.looseObject({ runId: z.string().min(1), reason: z.string().optional() });

/** What the channel is opened with. */
export interface ChannelOptions {
  /** The router's address, with no trailing slash. */
  url: string;
  /** The worker key. */
  key: string;
  /**
   * Runs once each time the channel opens, before its messages are read: the hello. A failure drops the channel,
   * which is dialled again.
   */
  onOpen: () => Promise<void>;
  /** Hears each assign and cancel, in order. */
  onMessage: (message: ChannelMessage) => void;
  /**
   * Makes the requests.
   *
   * @defaultValue `globalThis.fetch`
   */
  fetch?: typeof globalThis.fetch;
}

/** The open channel, dialled again whenever it drops. */
export interface Channel {
  /**
   * Whether the channel is open now.
   *
   * @returns true between its hello and its drop.
   */
  isOpen(): boolean;
  /**
   * Stops dialling and drops the channel.
   *
   * @returns Resolves once the loop has ended.
   */
  close(): Promise<void>;
}

/**
 * Reads one server-sent event as a channel message.
 *
 * @param event - The event's name: the message's type.
 * @param data - Its data, JSON.
 * @returns The message, or undefined for one this worker doesn't know or can't read, which is logged.
 *
 * @remarks
 * The type is the event's name. The data may repeat it, as the message object itself, or leave it out.
 */
export function parseChannelMessage(event: string | undefined, data: string): ChannelMessage | undefined {
  if (event === ChannelMessageType.Ping) {
    return { type: ChannelMessageType.Ping };
  }
  let body: unknown;
  try {
    body = JSON.parse(data);
  } catch {
    console.warn(`[worker] ignoring a "${event ?? 'message'}" on the channel whose data is not JSON`);
    return undefined;
  }
  if (event === ChannelMessageType.Assign) {
    const parsed = assignDataSchema.safeParse(body);
    if (parsed.success) {
      // The router built it as a RunAssignment, and only the runner reads the rest of it.
      const assignment = parsed.data.assignment as unknown as RunAssignment;
      return { type: ChannelMessageType.Assign, assignment };
    }
  }
  if (event === ChannelMessageType.Cancel) {
    const parsed = cancelDataSchema.safeParse(body);
    if (parsed.success) {
      return { type: ChannelMessageType.Cancel, runId: parsed.data.runId, reason: parsed.data.reason ?? NO_REASON };
    }
  }
  console.warn(`[worker] ignoring a "${event ?? 'message'}" on the channel this worker can't read`);
  return undefined;
}

/**
 * Dials the router's channel and keeps it open: each drop is dialled again, after a wait that doubles up to a cap.
 *
 * @param options - The router, the key, and who hears the channel.
 * @param [overrides] - Settings that replace `WORKER_DEFAULTS` and `WORKER_PROGRAM_DEFAULTS`.
 * @returns The channel.
 *
 * @remarks
 * Nothing on the channel, a ping included, for `silentHeartbeats` heartbeats drops it as dead.
 */
export function openChannel(
  options: ChannelOptions,
  overrides: Partial<WorkerSettings & WorkerProgramSettings> = {},
): Channel {
  const { url, key, onOpen, onMessage, fetch = globalThis.fetch } = options;
  const settings = { ...WORKER_DEFAULTS, ...WORKER_PROGRAM_DEFAULTS, ...overrides };
  const deadAfterMs = settings.heartbeatMs * settings.silentHeartbeats;
  const channelUrl = `${url}${WORKERS_PATH}${WorkerDoor.Channel}`;
  const stopping = new AbortController();
  let isOpen = false;

  /**
   * Holds one connection open until it drops.
   *
   * @returns Resolves with why it dropped, and whether it got as far as its hello.
   */
  const hold = async (): Promise<{ reason: string; opened: boolean }> => {
    let opened = false;
    const connection = new AbortController();
    let watchdog: NodeJS.Timeout | undefined;
    const heard = (): void => {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        () => connection.abort(new Error(`nothing on the channel for ${deadAfterMs / MS_PER_SECOND}s`)),
        deadAfterMs,
      );
    };
    const signal = AbortSignal.any([stopping.signal, connection.signal]);
    try {
      heard();
      const response = await fetch(channelUrl, {
        headers: { authorization: `Bearer ${key}`, accept: EVENT_STREAM },
        signal,
      });
      const { body } = response;
      if (response.ok === false || body === null) {
        await response.body?.cancel().catch(() => undefined);
        return { reason: `the router answered ${response.status}`, opened };
      }
      await onOpen();
      isOpen = true;
      opened = true;
      const events = body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream({ onComment: heard }));
      for await (const event of events) {
        heard();
        const message = parseChannelMessage(event.event, event.data);
        if (message !== undefined && message.type !== ChannelMessageType.Ping) {
          onMessage(message);
        }
      }
      return { reason: 'the router closed the channel', opened };
    } catch (error) {
      const reason = connection.signal.aborted ? connection.signal.reason : error;
      return { reason: errorMessage(reason), opened };
    } finally {
      isOpen = false;
      clearTimeout(watchdog);
      connection.abort();
    }
  };

  const loop = async (): Promise<void> => {
    let waitMs = settings.reconnectMinMs;
    while (stopping.signal.aborted === false) {
      const { reason, opened } = await hold();
      if (stopping.signal.aborted) {
        return;
      }
      // A channel that opened has dropped, rather than failed to dial: start the waits again from the shortest.
      if (opened) {
        waitMs = settings.reconnectMinMs;
      }
      console.warn(`[worker] the channel dropped: ${reason}. Dialling again in ${waitMs / MS_PER_SECOND}s.`);
      await delay(waitMs, undefined, { signal: stopping.signal }).catch(() => undefined);
      waitMs = Math.min(waitMs * BACKOFF_FACTOR, settings.reconnectMaxMs);
    }
  };
  const done = loop();

  return {
    isOpen: () => isOpen,
    close: async () => {
      stopping.abort();
      await done;
    },
  };
}
