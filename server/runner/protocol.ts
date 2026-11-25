/**
 * The worker protocol: what a remote worker and the router say to each other, shared by both ends.
 *
 * @remarks
 * A worker dials in with its worker key and holds one server-sent event stream open, the channel, which carries what
 * the router asks of it. Everything the worker says goes up as an ordinary request, each scoped to one run the router
 * assigned it. The router answers every run-scoped request for a run that is not running on that worker with 404.
 *
 * It lives beside the runner, not in `workers/`, because the worker program imports it without the router.
 */
import { z } from 'zod';
import type { RunAssignment, RunOutcome } from './assignment.ts';

/** Where the worker doors are mounted. */
export const WORKERS_PATH = '/workers';

/** The doors, under {@link WORKERS_PATH}. */
export const WorkerDoor = {
  /** `GET`: the channel, a server-sent event stream of {@link ChannelMessage}s. */
  Channel: '/channel',
  /** `POST` a {@link WorkerHello}: who the worker is and the tools it offers. */
  Hello: '/hello',
  /** The run's model calls, as an OpenAI-compatible base URL: `/chat/completions`, `/models`. */
  Model: '/model',
  /** `POST` a {@link RouterToolCall}, answered with a {@link RouterToolAnswer}. */
  Tools: '/tools/call',
  /** `POST` an {@link EventBatch}. */
  Events: '/events',
  /** `POST` the stretch's {@link RunOutcome}. */
  Finish: '/finish',
} as const;
export type WorkerDoor = (typeof WorkerDoor)[keyof typeof WorkerDoor];

/**
 * The path of one of a run's doors, under {@link WORKERS_PATH}.
 *
 * @param runId - The run.
 * @param door - Its door.
 * @returns The path, such as `/runs/<id>/events`.
 */
export function runDoorPath(runId: string, door: WorkerDoor): string {
  return `/runs/${encodeURIComponent(runId)}${door}`;
}

/** What the channel carries, by its server-sent event name. */
export const ChannelMessageType = {
  /** A stretch of a run to execute: a {@link RunAssignment}. */
  Assign: 'assign',
  /** Stop a run: its loop, its model and tool calls. */
  Cancel: 'cancel',
  /** Nothing, so a quiet channel is known to be open. */
  Ping: 'ping',
} as const;
export type ChannelMessageType = (typeof ChannelMessageType)[keyof typeof ChannelMessageType];

/** A stretch of a run for the worker to execute. */
export interface AssignMessage {
  type: typeof ChannelMessageType.Assign;
  assignment: RunAssignment;
}

/** A run the worker must stop. It still finishes the run, with a failed outcome. */
export interface CancelMessage {
  type: typeof ChannelMessageType.Cancel;
  runId: string;
  reason: string;
}

/** A heartbeat. */
export interface PingMessage {
  type: typeof ChannelMessageType.Ping;
}

/** One message on the channel. */
export type ChannelMessage = AssignMessage | CancelMessage | PingMessage;

/** One of a local server's tools, as MCP lists it. */
export const localToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type LocalTool = z.infer<typeof localToolSchema>;

/** One of the worker's own servers, and its tools. */
export const localServerSchema = z.object({
  name: z.string().min(1),
  tools: z.array(localToolSchema),
});
export type LocalServer = z.infer<typeof localServerSchema>;

/** What a worker says when its channel opens, and again whenever its servers or tools change. */
export const workerHelloSchema = z.object({
  /** The machine it runs on, as its owner would recognise it. */
  host: z.string().min(1),
  /** The worker program's version. */
  version: z.string().min(1),
  /** The servers it offers runs, called on the worker itself. */
  servers: z.array(localServerSchema),
});
export type WorkerHello = z.infer<typeof workerHelloSchema>;

/** A call to one of the router's servers, made for the run. */
export const routerToolCallSchema = z.object({
  /** The server's id, as the run's targets name it. */
  server: z.string().min(1),
  /** The tool's own name on its server. */
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()),
  /** The model's call, as the loop numbered it. */
  call: z.object({ id: z.string().min(1), name: z.string().min(1) }),
});
export type RouterToolCall = z.infer<typeof routerToolCallSchema>;

/** What a router tool said: its text, or the failure the model is told. */
export type RouterToolAnswer = { ok: true; text: string } | { ok: false; error: string };

/**
 * A batch of the loop's events, as agent-core's `RunEventInput`, in order. The router numbers them, so they carry no
 * `seq`, and checks only that each is an object with a `kind`.
 */
export const eventBatchSchema = z.object({
  events: z.array(z.looseObject({ kind: z.string().min(1) })),
});
export type EventBatch = z.infer<typeof eventBatchSchema>;

/** A stretch's end, as the worker reports it. The shape is the runner's {@link RunOutcome}. */
export const runOutcomeSchema = z.discriminatedUnion('ok', [
  z.looseObject({
    ok: z.literal(true),
    messages: z.array(z.unknown()),
    usage: z.unknown(),
    loaded: z.array(z.string()),
    finishReason: z.unknown(),
    handedBack: z.array(z.string()),
  }),
  z.object({ ok: z.literal(false), error: z.string(), usage: z.unknown() }),
]);

/** Re-exported so both ends name the same shapes. */
export type { RunAssignment, RunOutcome };
