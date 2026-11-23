import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PROGRESS_FIELD, progressEvent } from '@cubicecho/agent-core';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  type CallToolRequest,
  type CallToolResult,
  CallToolResultSchema,
  CancelTaskResultSchema,
  CreateTaskResultSchema,
  type ElicitRequest,
  ElicitRequestSchema,
  type ElicitResult,
  GetTaskResultSchema,
  type JSONRPCMessage,
  McpError,
  ErrorCode as McpErrorCode,
  type Progress,
  RELATED_TASK_META_KEY,
  type Tool,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { version } from '../core/config.ts';
import { INSTANCE_DEFAULTS, type InstanceSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import { CAN_ELICIT_META_KEY, HttpStatus, RUN_EVENT_META_KEY } from '../core/wire.ts';
import type { ToolElicit, ToolProgress } from './api.ts';
import type { BuiltinConnector } from './builtin.ts';
import { type ChildIsolation, ChildMode, type ChildUser } from './child-users.ts';
import { type ChildExec, childCommand, childEnv, execChild } from './install-folder.ts';
import {
  type HttpTransportType,
  type ResolvedServer,
  TRANSPORT_BUILTIN,
  TRANSPORT_SSE,
  TRANSPORT_STDIO,
  TRANSPORT_STREAMABLE_HTTP,
} from './shapes.ts';
import { isToolError, toolResultText } from './tool-result.ts';

/** What the router calls itself in the handshake. */
const CLIENT_NAME = 'ai-router';

/**
 * The SDK's client for each HTTP transport. Both take the address, the headers on every request, and the login.
 * The SSE client is deprecated in the SDK, which keeps it for servers that still speak only SSE.
 */
const HTTP_CLIENTS = Object.freeze({
  [TRANSPORT_STREAMABLE_HTTP]: StreamableHTTPClientTransport,
  [TRANSPORT_SSE]: SSEClientTransport,
} satisfies Record<HttpTransportType, unknown>);

/**
 * Signals one process, run by node as the server's own user: `node -e <this> <pid> <signal>`. The image has no
 * `kill` program, and the router may not signal another user's process itself.
 */
const KILL_SCRIPT = 'process.kill(Number(process.argv[1]), process.argv[2])';

/** What `env` reads as a variable to set, so an isolated command may not hold it. */
const ENV_ASSIGNMENT = '=';

/** The signals a stopping program gets, in order, after its stdin closes. */
const STOP_SIGNALS = ['SIGTERM', 'SIGKILL'] as const;
/** One of the signals a stopping program gets. */
type StopSignal = (typeof STOP_SIGNALS)[number];

/** Where an instance is in its life. */
export const InstanceState = {
  /** No program and no connection. The next call starts one. */
  Stopped: 'stopped',
  /** Starting the program or connecting, up to the end of the handshake. */
  Starting: 'starting',
  /** Connected, and taking calls. */
  Ready: 'ready',
  /** Would not start, or its program exited. The next start waits out a backoff. */
  Failed: 'failed',
} as const;
export type InstanceState = (typeof InstanceState)[keyof typeof InstanceState];

/** Why an instance could not do what it was asked. */
export const InstanceErrorCode = {
  /** The router won't start it: stdio servers are refused, or it has no user or folder of its own. */
  Refused: 'refused',
  /** It failed a moment ago and is waiting out its backoff. */
  BackedOff: 'backed-off',
  /** Its program would not start, or the server would not finish the handshake. */
  StartFailed: 'start-failed',
  /** A call or a listing ran past its time. */
  TimedOut: 'timed-out',
  /** The connection closed under a call: the program exited, or it was stopped. */
  Closed: 'closed',
  /** The server answered in a way the router won't take, such as endless pages of tools. */
  Misbehaved: 'misbehaved',
} as const;
export type InstanceErrorCode = (typeof InstanceErrorCode)[keyof typeof InstanceErrorCode];

/** What went wrong with an instance, beside the message. */
export interface InstanceErrorDetails {
  /** What its program last wrote to stderr. Empty when it wrote nothing, or has no program. */
  detail?: string;
  /** For a backed-off instance, when it may start again, in ms since the epoch. */
  retryAt?: number;
  /** What was caught. */
  cause?: unknown;
}

/** An instance that could not start, list or call. The message names the server and, where there is one, its stderr. */
export class InstanceError extends Error {
  readonly code: InstanceErrorCode;
  readonly serverName: string;
  /** What the program last wrote to stderr, or empty. */
  readonly detail: string;
  /** When a backed-off instance may start again, in ms since the epoch. */
  readonly retryAt: number | undefined;

  /**
   * Builds the error.
   *
   * @param code - Why.
   * @param serverName - The server, for the message.
   * @param message - What went wrong, as a clause after the server's name.
   * @param [details] - Its stderr, when it may retry, and the cause.
   */
  constructor(code: InstanceErrorCode, serverName: string, message: string, details: InstanceErrorDetails = {}) {
    const { detail = '', retryAt, cause } = details;
    super(`Server "${serverName}" ${message}${detail === '' ? '' : `: ${detail}`}`, { cause });
    this.name = 'InstanceError';
    this.code = code;
    this.serverName = serverName;
    this.detail = detail;
    this.retryAt = retryAt;
  }
}

/** One tool call, as the activity hook hears of it. */
export interface ToolCallEvent {
  serverId: string;
  /** The workspace whose instance answered, or null for the base instance. */
  workspaceId: string | null;
  /** The tool's name at its server. */
  tool: string;
  /** How long the call took, start included. */
  ms: number;
  /** false when the call threw, or the tool answered with `isError`. */
  ok: boolean;
  /** Why it failed. */
  error?: string;
}

/** Hears of every tool call an instance makes. */
export type ToolCallHook = (event: ToolCallEvent) => void;

/** What one tool call may carry. */
export interface CallOptions {
  /** Aborts the call; the server is told it was cancelled. */
  signal?: AbortSignal;
  /** How long the call may take. Shortens the server's `callTimeoutMs`, and never lengthens it. */
  timeoutMs?: number;
  /** The request's `_meta`: the depth an agent the call starts would be at, and for the admin server, its run. */
  meta?: Record<string, unknown>;
  /** Hears what the server says while the call runs. */
  onProgress?: (progress: ToolProgress) => void;
  /** Answers the server's questions during the call. Absent, each is declined. */
  onElicit?: ToolElicit;
}

/** One tool call in flight, which a server's question may belong to. */
interface CallInFlight {
  onElicit: ToolElicit | undefined;
  signal: AbortSignal | undefined;
  /** The task it runs as, once the server has said. */
  taskId: string | undefined;
  /** When a question on a plain call must be answered by, in ms since the epoch. */
  answerBy: number;
  /** How long a question on a task may wait: its timeout covers each quiet stretch. */
  taskWaitMs: number;
  /** The questions being answered, by request id, since asking again on a new `tasks/result` repeats one. */
  asked: Map<string | number, Promise<ElicitResult>>;
}

/** What the router tells a server it can do: answer form questions. A `url` question is never declared. */
const CLIENT_CAPABILITIES = { elicitation: { form: {} } };
/** The answer to a question nobody can answer. */
const DECLINED: ElicitResult = { action: 'decline' };

/** A task's statuses that the server is still working through. */
const TASK_WORKING = 'working';
/** A task that waits for its caller to answer the server. */
const TASK_INPUT_REQUIRED = 'input_required';
/** How a tool says it may run as a task, in its listing. */
const TASK_SUPPORT: ReadonlySet<string> = new Set(['optional', 'required']);

/** What an instance is built with, beside its server. */
export interface InstanceOptions {
  /** How stdio programs run, from the boot check. */
  isolation: ChildIsolation;
  /** Signs a streamable-HTTP or SSE server's requests in. Ignored over stdio. */
  authProvider?: OAuthClientProvider;
  /** Connects the built-in admin server in process. Without it, the built-in server refuses to start. */
  builtin?: BuiltinConnector;
  /** Hears of every tool call. */
  onCall?: ToolCallHook;
  /** Runs the helper that signals an isolated program as its own user. Tests pass a recorder. */
  exec?: ChildExec;
  /** Where `run-as-child` is. `RUN_AS_CHILD`, or the image's path, when absent. */
  helperPath?: string;
}

/** One live connection, and the transport it runs over. */
interface Connection {
  client: Client;
  transport: Transport;
}

/** What starts one stdio program. */
interface ChildSpec {
  command: string;
  args: string[];
  /** The whole environment: nothing is added to it. */
  env: Record<string, string>;
  /** The folder spawn starts it in. Absent when isolated: the router may not enter it, so `env -C` does. */
  cwd: string | undefined;
  /** Sends a stopping program a signal. */
  signal: (child: ChildProcessWithoutNullStreams, signal: StopSignal) => Promise<void>;
}

/**
 * Speaks MCP over a child's stdin and stdout, with exactly the environment it is given.
 *
 * @remarks
 * The SDK's `StdioClientTransport` merges `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and `USER` from the router's
 * own environment under the env it is handed, so a variable the allowlist leaves out would still reach the child.
 * This one spawns with the env as given, and an argument array with no shell.
 */
class ChildTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  private readonly spec: ChildSpec;
  private readonly closeGraceMs: number;
  private readonly onStderr: (text: string) => void;
  private readonly buffer = new ReadBuffer();
  private child: ChildProcessWithoutNullStreams | undefined;

  /**
   * Builds the transport; nothing runs until `start`.
   *
   * @param spec - The program, its arguments, env and folder.
   * @param closeGraceMs - How long `close` waits after each step before the next.
   * @param onStderr - Hears everything the program writes to stderr.
   */
  constructor(spec: ChildSpec, closeGraceMs: number, onStderr: (text: string) => void) {
    this.spec = spec;
    this.closeGraceMs = closeGraceMs;
    this.onStderr = onStderr;
  }

  /**
   * Starts the program.
   *
   * @returns Resolves once it is running, and rejects when it can't be spawned.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { command, args, env, cwd } = this.spec;
      const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      this.child = child;
      child.once('spawn', () => resolve());
      child.on('error', (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.once('close', () => this.finish(child));
      child.stdin.on('error', (error) => this.onerror?.(error));
      child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
      child.stderr.on('data', (chunk: Buffer) => this.onStderr(chunk.toString()));
    });
  }

  /**
   * Hands on every whole message the program has written.
   *
   * @param chunk - What just arrived on stdout.
   */
  private read(chunk: Buffer): void {
    this.buffer.append(chunk);
    for (;;) {
      try {
        const message = this.buffer.readMessage();
        if (message === null) {
          return;
        }
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(errorMessage(error)));
      }
    }
  }

  /**
   * Writes one message to the program.
   *
   * @param message - The message.
   * @returns Resolves once the write is flushed or buffered.
   */
  send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      return Promise.reject(new Error('Not connected'));
    }
    return new Promise((resolve) => {
      const isFlushed = child.stdin.write(serializeMessage(message));
      if (isFlushed) {
        resolve();
      } else {
        child.stdin.once('drain', () => resolve());
      }
    });
  }

  /**
   * Stops the program: closes its stdin, then sends SIGTERM, then SIGKILL, waiting `closeGraceMs` between.
   *
   * @returns Resolves once it has exited, or the last signal is sent.
   *
   * @remarks
   * An MCP server exits when its input ends, so closing stdin is what usually stops it. The signals go through
   * `spec.signal`: straight from the router for a program running as its user, through the helper for an isolated one.
   */
  async close(): Promise<void> {
    const child = this.child;
    if (child === undefined) {
      return;
    }
    const exited = new Promise<boolean>((resolve) => child.once('close', () => resolve(true)));
    child.stdin.end();
    for (const signal of STOP_SIGNALS) {
      const hasExited = await Promise.race([exited, delay(this.closeGraceMs, false, { ref: false })]);
      if (hasExited) {
        return;
      }
      await this.spec.signal(child, signal);
    }
  }

  /**
   * Notes that the program has exited and its pipes are closed.
   *
   * @param child - The program that closed. Ignored once it is no longer this transport's.
   */
  private finish(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) {
      return;
    }
    this.child = undefined;
    this.buffer.clear();
    this.onclose?.();
  }
}

/**
 * Signals a program that runs as the router's own user.
 *
 * @param child - The program.
 * @param signal - The signal.
 * @returns Resolves at once.
 */
function signalDirectly(child: ChildProcessWithoutNullStreams, signal: StopSignal): Promise<void> {
  child.kill(signal);
  return Promise.resolve();
}

/**
 * What the SDK's SSE client rejects with when a message is posted to a session the server doesn't have. It carries no
 * status of its own, only this message.
 */
const SSE_SESSION_LOST = /^Error POSTing to endpoint \(HTTP 404\)/;

/**
 * Whether a request failed because an HTTP server no longer has the session it was sent on, as a restarted one doesn't.
 *
 * @param transport - The transport the request went out on.
 * @param error - What the request rejected with.
 * @returns true for a 404 to a session the server forgot, or, over streamable HTTP, a 400 to a request that carried
 * none from a server that now wants one. Each comes before the server runs anything, so sending the request again is
 * safe. A request the server took and never answered is not one of them: it may have run.
 */
function isSessionLost(transport: Transport, error: unknown): boolean {
  if (transport instanceof SSEClientTransport) {
    return error instanceof Error && SSE_SESSION_LOST.test(error.message);
  }
  const isHttpError = error instanceof StreamableHTTPError;
  if (isHttpError === false) {
    return false;
  }
  const lostStatus = transport.sessionId === undefined ? HttpStatus.BadRequest : HttpStatus.NotFound;
  return error.code === lostStatus;
}

/**
 * Whether a caught value is the SDK's error with one code.
 *
 * @param error - What was caught.
 * @param code - The JSON-RPC error code.
 * @returns true for an `McpError` with that code.
 */
function isMcpError(error: unknown, code: McpErrorCode): boolean {
  return error instanceof McpError && error.code === code;
}

/**
 * Passes on what a server says while a call runs.
 *
 * @param onProgress - Hears each step of an agent run, or else each message.
 * @returns The SDK's progress listener. A notification with neither says nothing to pass on.
 *
 * @remarks
 * A server is untrusted, so its event goes through agent-core's reader, which drops a malformed one.
 */
function progressListener(onProgress: (progress: ToolProgress) => void): (progress: Progress) => void {
  return (progress) => {
    const meta: unknown = (progress as { _meta?: Record<string, unknown> })._meta?.[RUN_EVENT_META_KEY];
    const event = meta === undefined ? undefined : progressEvent({ [PROGRESS_FIELD]: { event: meta } });
    if (event !== undefined) {
      onProgress({ event });
    } else if (progress.message !== undefined && progress.message !== '') {
      onProgress({ message: progress.message });
    }
  };
}

/**
 * One running connection to one server: a stdio program the router started, or a server it reached over HTTP.
 *
 * @remarks
 * Starts on the first call, and a failed start or an exited program waits out a backoff that grows with each
 * failure in a row. A stdio program with no call in flight for `idleTimeoutMs` is stopped, and the next call starts
 * it again. The tool list is kept, through stops and restarts, until the server says its tools changed.
 */
export class Instance {
  readonly server: ResolvedServer;
  private readonly isolation: ChildIsolation;
  private readonly authProvider: OAuthClientProvider | undefined;
  private readonly builtin: BuiltinConnector | undefined;
  private readonly onCall: ToolCallHook | undefined;
  private readonly exec: ChildExec;
  private readonly helperPath: string | undefined;
  private readonly settings: InstanceSettings;
  private status: InstanceState = InstanceState.Stopped;
  private connection: Connection | undefined;
  private starting: Promise<Connection> | undefined;
  private tools: Promise<Tool[]> | undefined;
  private inFlight = 0;
  /** The tool calls going, which a server's question is matched to. */
  private readonly calls = new Set<CallInFlight>();
  private idleTimer: NodeJS.Timeout | undefined;
  private failures = 0;
  private retryAt = 0;
  private lastFailure = '';
  private stderrTail = '';
  private isRetiring = false;
  private readonly drained: (() => void)[] = [];

  /**
   * Builds a stopped instance.
   *
   * @param server - What to start or connect to.
   * @param options - The isolation mode, the server's login, and the call hook.
   * @param [overrides] - Settings that differ from `INSTANCE_DEFAULTS`. The idle and call timeouts come from `server`.
   */
  constructor(server: ResolvedServer, options: InstanceOptions, overrides: Partial<InstanceSettings> = {}) {
    this.server = server;
    this.isolation = options.isolation;
    this.authProvider = options.authProvider;
    this.builtin = options.builtin;
    this.onCall = options.onCall;
    this.exec = options.exec ?? execChild;
    this.helperPath = options.helperPath;
    this.settings = { ...INSTANCE_DEFAULTS, ...overrides };
  }

  /**
   * Reads where the instance is in its life.
   *
   * @returns The state.
   */
  get state(): InstanceState {
    return this.status;
  }

  /**
   * Counts the calls and listings running on it now.
   *
   * @returns How many are in flight.
   */
  get inFlightCount(): number {
    return this.inFlight;
  }

  /**
   * Reads why it last failed.
   *
   * @returns Its program's stderr, or the error, from the last failure. Empty once it has started since.
   */
  get error(): string {
    return this.lastFailure;
  }

  /**
   * Starts the program or connects, unless it is already ready.
   *
   * @returns Resolves once it is ready. Throws an `InstanceError` when it is refused, backed off, or won't start.
   */
  async start(): Promise<void> {
    await this.connect();
  }

  /**
   * Lists the server's tools, by their own names.
   *
   * @returns The tools. Kept until the server says they changed, so a stopped instance answers without starting.
   */
  async listTools(): Promise<Tool[]> {
    this.tools ??= this.fetchTools();
    const pending = this.tools;
    try {
      return [...(await pending)];
    } catch (error) {
      if (this.tools === pending) {
        this.tools = undefined;
      }
      throw error;
    }
  }

  /**
   * Calls one of the server's tools: as a task, when the tool's listing and the server say it can run as one.
   *
   * @param tool - The tool's name at the server.
   * @param args - Its arguments.
   * @param [options] - An abort signal, a shorter timeout, the request's `_meta` and a progress listener.
   * @returns What the tool answered, `isError` results included. Throws an `InstanceError` when the instance can't
   * start, the call times out or the connection closes under it, and the SDK's error for anything else.
   *
   * @remarks
   * A task's call timeout covers starting it and each quiet stretch after: a task that sends progress, or that the
   * server says is still working, goes on until it ends or `options.signal` aborts it, which cancels the task. Without
   * a signal, the call timeout covers the whole task.
   */
  async callTool(tool: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<CallToolResult> {
    const startedAt = Date.now();
    const { callTimeoutMs } = this.server;
    const timeout = Math.min(options.timeoutMs ?? callTimeoutMs, callTimeoutMs);
    const meta = options.onElicit === undefined ? options.meta : { ...options.meta, [CAN_ELICIT_META_KEY]: true };
    const params: CallToolRequest['params'] = {
      name: tool,
      arguments: args,
      ...(meta === undefined ? {} : { _meta: meta }),
    };
    const call: CallInFlight = {
      onElicit: options.onElicit,
      signal: options.signal,
      taskId: undefined,
      answerBy: startedAt + timeout - this.settings.elicitMarginMs,
      taskWaitMs: timeout - this.settings.elicitMarginMs,
      asked: new Map(),
    };
    const onprogress = options.onProgress === undefined ? undefined : progressListener(options.onProgress);
    this.begin();
    this.calls.add(call);
    try {
      const isTask = await this.runsAsTask(tool);
      const result = isTask
        ? await this.callAsTask(params, call, timeout, options.signal ?? AbortSignal.timeout(timeout), onprogress)
        : await this.withConnection(({ client }) =>
            client.request({ method: 'tools/call', params }, CallToolResultSchema, {
              signal: options.signal,
              timeout,
              ...(onprogress === undefined ? {} : { onprogress }),
            }),
          );
      this.report(tool, startedAt, isToolError(result) ? toolResultText(result) : undefined);
      return result;
    } catch (error) {
      const failure = this.failureOf(error, 'did not answer the call in time');
      this.report(tool, startedAt, errorMessage(failure));
      throw failure;
    } finally {
      this.calls.delete(call);
      this.end();
    }
  }

  /**
   * Stops the program or closes the connection now, calls in flight included. The next call starts it again, with
   * no backoff.
   *
   * @returns Resolves once it is closed.
   */
  async stop(): Promise<void> {
    this.clearIdleTimer();
    if (this.starting !== undefined) {
      await this.starting.catch(() => undefined);
      this.clearIdleTimer();
    }
    // Taken off synchronously, so a call that begins from here on gets a connection of its own.
    const connection = this.connection;
    this.connection = undefined;
    this.status = InstanceState.Stopped;
    this.retryAt = 0;
    await connection?.client.close().catch(() => undefined);
  }

  /**
   * Stops the instance once its calls in flight are done, for one whose server's settings changed.
   *
   * @returns Resolves once it is stopped.
   */
  async retire(): Promise<void> {
    this.isRetiring = true;
    this.clearIdleTimer();
    if (this.inFlight > 0) {
      await new Promise<void>((resolve) => this.drained.push(resolve));
    }
    await this.stop();
  }

  /**
   * Whether a call to a tool runs as a task: its listing says it may, and the server says it takes tool calls as tasks.
   *
   * @param tool - The tool's name at the server.
   * @returns true to call it as a task. A listing that fails says no, and the call itself reports why.
   */
  private async runsAsTask(tool: string): Promise<boolean> {
    const listed = await this.listTools().catch(() => []);
    const support = listed.find((entry) => entry.name === tool)?.execution?.taskSupport;
    const isOffered = support !== undefined && TASK_SUPPORT.has(support);
    if (isOffered === false) {
      return false;
    }
    return this.withConnection(
      async ({ client }) => client.getServerCapabilities()?.tasks?.requests?.tools?.call !== undefined,
    );
  }

  /**
   * Calls a tool as a task, and waits for its result.
   *
   * @param params - The call.
   * @param call - The call in flight, told its task's id.
   * @param timeout - How long starting it, and each quiet stretch after, may take.
   * @param signal - Ends the wait. When it aborts, the server is asked to cancel the task.
   * @param [onprogress] - Hears the task's progress.
   * @returns What the tool answered.
   */
  private async callAsTask(
    params: CallToolRequest['params'],
    call: CallInFlight,
    timeout: number,
    signal: AbortSignal,
    onprogress?: (progress: Progress) => void,
  ): Promise<CallToolResult> {
    const created = await this.withConnection(({ client }) =>
      client.request({ method: 'tools/call', params }, CreateTaskResultSchema, { signal, timeout, task: {} }),
    );
    const { taskId } = created.task;
    call.taskId = taskId;
    try {
      return await this.taskResult(taskId, call, timeout, signal, onprogress);
    } catch (error) {
      if (signal.aborted) {
        await this.withConnection(({ client }) =>
          client.request({ method: 'tasks/cancel', params: { taskId } }, CancelTaskResultSchema, { timeout }),
        ).catch((cancelError: unknown) =>
          console.warn(`[tools] could not cancel task ${taskId} on ${this.server.name}: ${errorMessage(cancelError)}`),
        );
      }
      throw error;
    }
  }

  /**
   * Waits for a task's result: `tasks/result` with its progress, asking how the task stands whenever a whole timeout
   * passes without a word.
   *
   * @param taskId - The task.
   * @param call - The call in flight, which says whether anyone can answer the task's questions.
   * @param timeout - How long a quiet stretch may last before the task is checked.
   * @param signal - Ends the wait.
   * @param [onprogress] - Hears the task's progress.
   * @returns What the tool answered.
   * @throws {@link InstanceError} When the task asks for input and the call has nobody to answer it.
   */
  private async taskResult(
    taskId: string,
    call: CallInFlight,
    timeout: number,
    signal: AbortSignal,
    onprogress?: (progress: Progress) => void,
  ): Promise<CallToolResult> {
    for (;;) {
      try {
        return await this.withConnection(({ client }) =>
          client.request({ method: 'tasks/result', params: { taskId } }, CallToolResultSchema, {
            signal,
            timeout,
            resetTimeoutOnProgress: true,
            ...(onprogress === undefined ? {} : { onprogress }),
          }),
        );
      } catch (error) {
        // The SDK reports an abort as a timeout too.
        const isQuiet = isMcpError(error, McpErrorCode.RequestTimeout) && signal.aborted === false;
        if (isQuiet === false) {
          throw error;
        }
      }
      const task = await this.withConnection(({ client }) =>
        client.request({ method: 'tasks/get', params: { taskId } }, GetTaskResultSchema, { signal, timeout }),
      );
      const isUnanswerable = task.status === TASK_INPUT_REQUIRED && call.onElicit === undefined;
      if (isUnanswerable) {
        throw new InstanceError(
          InstanceErrorCode.Misbehaved,
          this.server.name,
          `asked for input during task ${taskId}, which a run's tool call can't give`,
        );
      }
      // Its questions come on `tasks/result`, so a task waiting for an answer is asked again too.
      if (task.status === TASK_WORKING || task.status === TASK_INPUT_REQUIRED) {
        await delay(task.pollInterval ?? this.settings.taskPollIntervalMs, undefined, { signal });
      }
    }
  }

  /**
   * Reads every page of the server's tools.
   *
   * @returns The tools.
   */
  private async fetchTools(): Promise<Tool[]> {
    const { listTimeoutMs, maxToolListPages } = this.settings;
    this.begin();
    try {
      return await this.withConnection(async ({ client }) => {
        const tools: Tool[] = [];
        // A server may offer no tools at all, and then it answers no listing.
        const offersTools = client.getServerCapabilities()?.tools !== undefined;
        if (offersTools === false) {
          return tools;
        }
        let cursor: string | undefined;
        for (let page = 0; page < maxToolListPages; page += 1) {
          const listing = await client.listTools(cursor === undefined ? {} : { cursor }, { timeout: listTimeoutMs });
          tools.push(...listing.tools);
          cursor = listing.nextCursor;
          if (cursor === undefined) {
            return tools;
          }
        }
        throw new InstanceError(
          InstanceErrorCode.Misbehaved,
          this.server.name,
          `lists more than ${maxToolListPages} pages of tools`,
        );
      });
    } catch (error) {
      throw this.failureOf(error, 'did not list its tools in time');
    } finally {
      this.end();
    }
  }

  /**
   * Runs one request on the connection, starting it first if need be. A streamable-HTTP or SSE server that lost the
   * session is connected to again, and the request sent once more.
   *
   * @typeParam T - What the request resolves to.
   * @param run - The request.
   * @returns What `run` resolved to.
   */
  private async withConnection<T>(run: (connection: Connection) => Promise<T>): Promise<T> {
    const connection = await this.connect();
    try {
      return await run(connection);
    } catch (error) {
      const isLost = isSessionLost(connection.transport, error);
      if (isLost === false) {
        throw error;
      }
      if (this.connection === connection) {
        await this.stop();
      }
      return run(await this.connect());
    }
  }

  /**
   * Hands back the live connection, starting one when there is none.
   *
   * @returns The connection. Throws an `InstanceError` when it is refused, backed off, or won't start.
   */
  private async connect(): Promise<Connection> {
    if (this.connection !== undefined) {
      return this.connection;
    }
    if (this.starting === undefined) {
      const isBackedOff = this.status === InstanceState.Failed && Date.now() < this.retryAt;
      if (isBackedOff) {
        throw new InstanceError(InstanceErrorCode.BackedOff, this.server.name, 'failed and is waiting to start again', {
          detail: this.lastFailure,
          retryAt: this.retryAt,
        });
      }
      this.starting = this.open().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  /**
   * Starts the program or connects, and waits for the handshake.
   *
   * @returns The new connection.
   */
  private async open(): Promise<Connection> {
    const transport = await this.transport();
    this.status = InstanceState.Starting;
    this.stderrTail = '';
    const client = new Client({ name: CLIENT_NAME, version: version() }, { capabilities: CLIENT_CAPABILITIES });
    const connection: Connection = { client, transport };
    client.onclose = () => this.closed(connection);
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      this.tools = undefined;
    });
    client.setRequestHandler(ElicitRequestSchema, (request, extra) =>
      this.answerQuestion(request.params, extra.requestId, extra.signal),
    );
    try {
      await client.connect(transport, { timeout: this.settings.startTimeoutMs });
    } catch (error) {
      await client.close().catch(() => undefined);
      const timedOut = isMcpError(error, McpErrorCode.RequestTimeout);
      const code = timedOut ? InstanceErrorCode.TimedOut : InstanceErrorCode.StartFailed;
      const failure = this.fail(error);
      throw new InstanceError(code, this.server.name, timedOut ? 'did not finish starting in time' : 'did not start', {
        detail: failure,
        cause: error,
      });
    }
    this.connection = connection;
    this.status = InstanceState.Ready;
    this.failures = 0;
    this.lastFailure = '';
    this.scheduleIdleStop();
    return connection;
  }

  /**
   * Finds the call a server's question belongs to.
   *
   * @param params - The question.
   * @returns The call its related task names, else the only call in flight. Undefined when it can't be told, since a
   * question must never reach a run it isn't about.
   */
  private callAsking(params: ElicitRequest['params']): CallInFlight | undefined {
    const related: unknown = params._meta?.[RELATED_TASK_META_KEY];
    const taskId = isRecord(related) && typeof related.taskId === 'string' ? related.taskId : undefined;
    const calls = [...this.calls];
    const own = taskId === undefined ? undefined : calls.find((call) => call.taskId === taskId);
    if (own !== undefined) {
      return own;
    }
    const [sole, other] = calls;
    const isSole = other === undefined && (taskId === undefined || sole?.taskId === undefined);
    return isSole ? sole : undefined;
  }

  /**
   * Answers a server's question, through the call it belongs to.
   *
   * @param params - The question.
   * @param requestId - Its id: a repeat of one being answered shares that answer, so nobody is asked twice.
   * @param serverSignal - Aborted when the server withdraws it.
   * @returns The answer. A decline when nobody can answer.
   */
  private answerQuestion(
    params: ElicitRequest['params'],
    requestId: string | number,
    serverSignal: AbortSignal,
  ): Promise<ElicitResult> {
    const call = this.callAsking(params);
    if (call?.onElicit === undefined) {
      return Promise.resolve(DECLINED);
    }
    const known = call.asked.get(requestId);
    if (known !== undefined) {
      return known;
    }
    const asked = this.askCaller(call, call.onElicit, params, serverSignal);
    call.asked.set(requestId, asked);
    return asked;
  }

  /**
   * Puts a question to whoever the call is for, for as long as the call's timeout leaves.
   *
   * @param call - The call.
   * @param onElicit - Who answers.
   * @param params - The question.
   * @param serverSignal - Aborted when the server withdraws it.
   * @returns The answer. A decline when time runs out or the answer can't be had.
   */
  private async askCaller(
    call: CallInFlight,
    onElicit: ToolElicit,
    params: ElicitRequest['params'],
    serverSignal: AbortSignal,
  ): Promise<ElicitResult> {
    const waitMs = call.taskId === undefined ? call.answerBy - Date.now() : call.taskWaitMs;
    if (waitMs <= 0) {
      return DECLINED;
    }
    const signals = [serverSignal, AbortSignal.timeout(waitMs), ...(call.signal === undefined ? [] : [call.signal])];
    try {
      return await onElicit(params, { signal: AbortSignal.any(signals) });
    } catch (error) {
      console.warn(`[tools] a question from ${this.server.name} went unanswered: ${errorMessage(error)}`);
      return DECLINED;
    }
  }

  /**
   * Builds the transport the server is reached over.
   *
   * @returns A stdio, streamable-HTTP, SSE or in-process transport, not yet started. Headers go on every request, the
   * SSE stream's included.
   */
  private async transport(): Promise<Transport> {
    const { transport } = this.server;
    if (transport.type === TRANSPORT_BUILTIN) {
      if (this.builtin === undefined) {
        throw new InstanceError(InstanceErrorCode.Refused, this.server.name, 'has no built-in server to connect to');
      }
      return this.builtin(this.server);
    }
    if (transport.type === TRANSPORT_STDIO) {
      return this.childTransport(transport.command, transport.args, transport.cwd);
    }
    const HttpClient = HTTP_CLIENTS[transport.type];
    return new HttpClient(new URL(transport.url), {
      requestInit: { headers: transport.headers },
      ...(this.authProvider === undefined ? {} : { authProvider: this.authProvider }),
    });
  }

  /**
   * Builds the transport for a stdio program, with the env allowlist and the server's own env, in its install folder
   * with its own HOME. Isolated, it runs as `run-as-child <uid> [-g <gid>] [-G <gids>] -- env -C <folder> <command>
   * <args…>` and is signalled through the helper as the same user. Shared, spawn starts it in the folder and the
   * router signals it.
   *
   * @param command - The program.
   * @param args - Its arguments.
   * @param [cwd] - Its folder, relative to the install folder. The install folder itself when absent.
   * @returns The transport. Throws a refusal when stdio servers are refused, it has no user, install folder or HOME,
   * or an isolated command holds `=`, which `env` would read as a variable.
   */
  private childTransport(command: string, args: string[], cwd: string | undefined): ChildTransport {
    const { isolation, server } = this;
    if (isolation.mode === ChildMode.Refused) {
      throw new InstanceError(InstanceErrorCode.Refused, server.name, 'was refused', { detail: isolation.reason });
    }
    const { runAs, installDir, homeDir } = server;
    if (runAs === null || installDir === null || homeDir === null) {
      throw new InstanceError(InstanceErrorCode.Refused, server.name, 'has no user or folder of its own');
    }
    const folder = path.resolve(installDir, cwd ?? '.');
    const env = { ...childEnv(homeDir), ...server.env };
    if (isolation.mode === ChildMode.Shared) {
      const launch = this.launch(runAs, command, args);
      return this.transportFor({ ...launch, env, cwd: folder, signal: signalDirectly });
    }
    // The router may not enter another user's folder, so the program moves into it once the helper has switched.
    const holdsAssignment = command.includes(ENV_ASSIGNMENT);
    if (holdsAssignment) {
      throw new InstanceError(InstanceErrorCode.Refused, server.name, `has a command holding "${ENV_ASSIGNMENT}"`);
    }
    const launch = this.launch(runAs, 'env', ['-C', folder, command, ...args]);
    return this.transportFor({
      ...launch,
      env,
      cwd: undefined,
      signal: (child, signal) => this.signalAsChild(runAs, homeDir, child, signal),
    });
  }

  /**
   * Builds a stdio transport that feeds the program's stderr to the tail.
   *
   * @param spec - The program and how to stop it.
   * @returns The transport.
   */
  private transportFor(spec: ChildSpec): ChildTransport {
    return new ChildTransport(spec, this.settings.closeGraceMs, (text) => this.noteStderr(text));
  }

  /**
   * Signals an isolated program through the helper, as its own user. A signal that can't be sent is logged.
   *
   * @param runAs - The user the program runs as. Only that uid may signal it.
   * @param homeDir - The program's HOME, for the helper's env.
   * @param child - The program. The helper execs in place, so its pid is the server's.
   * @param signal - The signal.
   * @returns Resolves once the helper is done.
   */
  private async signalAsChild(
    runAs: ChildUser,
    homeDir: string,
    child: ChildProcessWithoutNullStreams,
    signal: StopSignal,
  ): Promise<void> {
    const { pid } = child;
    if (pid === undefined) {
      return;
    }
    const { command, args } = this.launch(runAs, process.execPath, ['-e', KILL_SCRIPT, String(pid), signal]);
    try {
      await this.exec(command, args, { timeout: this.settings.signalTimeoutMs, env: childEnv(homeDir) });
    } catch (error) {
      console.warn(`[tools] could not send ${signal} to "${this.server.name}" (pid ${pid}): ${errorMessage(error)}`);
    }
  }

  /**
   * Works out the command line a program runs with under the isolation mode.
   *
   * @param runAs - The user it runs as.
   * @param command - The program.
   * @param args - Its arguments.
   * @returns The command and arguments to spawn. Throws a refusal when the mode refuses it.
   */
  private launch(runAs: ChildUser, command: string, args: string[]): { command: string; args: string[] } {
    try {
      return childCommand(this.isolation, runAs, command, args, this.helperPath);
    } catch (error) {
      throw new InstanceError(InstanceErrorCode.Refused, this.server.name, 'was refused', {
        detail: errorMessage(error),
        cause: error,
      });
    }
  }

  /**
   * Keeps the end of what the program writes to stderr.
   *
   * @param text - What it just wrote.
   */
  private noteStderr(text: string): void {
    this.stderrTail = (this.stderrTail + text).slice(-this.settings.stderrTailChars);
  }

  /**
   * Notes that a connection closed. One the router did not close itself is a failure.
   *
   * @param connection - The connection that closed. Ignored unless it is the live one.
   */
  private closed(connection: Connection): void {
    if (this.connection !== connection) {
      return;
    }
    this.connection = undefined;
    this.clearIdleTimer();
    this.fail(new Error('its program exited'));
  }

  /**
   * Marks the instance failed and starts its backoff.
   *
   * @param cause - What went wrong, used when the program wrote nothing to stderr.
   * @returns Why it failed, as kept: the stderr tail, else the cause's message.
   */
  private fail(cause: unknown): string {
    const { firstBackoffMs, backoffFactor, maxBackoffMs } = this.settings;
    this.status = InstanceState.Failed;
    this.failures += 1;
    const waitMs = Math.min(firstBackoffMs * backoffFactor ** (this.failures - 1), maxBackoffMs);
    this.retryAt = Date.now() + waitMs;
    const tail = this.stderrTail.trim();
    this.lastFailure = tail === '' ? errorMessage(cause) : tail;
    return this.lastFailure;
  }

  /**
   * Turns the SDK's timeout and closed-connection errors into the instance's own.
   *
   * @param error - What a request rejected with.
   * @param timeoutMessage - What a timeout is reported as.
   * @returns An `InstanceError` for a timeout or a closed connection, otherwise `error` itself.
   */
  private failureOf(error: unknown, timeoutMessage: string): unknown {
    const { name } = this.server;
    if (isMcpError(error, McpErrorCode.RequestTimeout)) {
      return new InstanceError(InstanceErrorCode.TimedOut, name, timeoutMessage, { cause: error });
    }
    if (isMcpError(error, McpErrorCode.ConnectionClosed)) {
      return new InstanceError(InstanceErrorCode.Closed, name, 'closed the connection during the call', {
        detail: this.stderrTail.trim(),
        cause: error,
      });
    }
    return error;
  }

  /**
   * Tells the call hook about one call. A hook that throws is logged, and the call keeps its outcome.
   *
   * @param tool - The tool.
   * @param startedAt - When the call began, in ms since the epoch.
   * @param [error] - Why it failed; absent for a call that succeeded.
   */
  private report(tool: string, startedAt: number, error?: string): void {
    const { id, workspaceId } = this.server;
    const event: ToolCallEvent = {
      serverId: id,
      workspaceId,
      tool,
      ms: Date.now() - startedAt,
      ok: error === undefined,
      ...(error === undefined ? {} : { error }),
    };
    try {
      this.onCall?.(event);
    } catch (hookError) {
      console.error(`[tools] the call hook failed: ${errorMessage(hookError)}`);
    }
  }

  /** Counts a request in flight, which holds off the idle stop. */
  private begin(): void {
    this.inFlight += 1;
    this.clearIdleTimer();
  }

  /** Counts a request done; the last one out starts the idle clock, or lets a retiring instance stop. */
  private end(): void {
    this.inFlight -= 1;
    if (this.inFlight > 0) {
      return;
    }
    if (this.isRetiring) {
      for (const resolve of this.drained.splice(0)) {
        resolve();
      }
      return;
    }
    this.scheduleIdleStop();
  }

  /** Stops a ready stdio program after `idleTimeoutMs` with nothing in flight. A remote server is never stopped. */
  private scheduleIdleStop(): void {
    this.clearIdleTimer();
    const isIdleStdio =
      this.server.transport.type === TRANSPORT_STDIO && this.status === InstanceState.Ready && this.inFlight === 0;
    if (isIdleStdio) {
      this.idleTimer = setTimeout(() => {
        void this.stop();
      }, this.server.idleTimeoutMs);
      this.idleTimer.unref();
    }
  }

  /** Cancels a pending idle stop. */
  private clearIdleTimer(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
