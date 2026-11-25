import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { errorMessage } from '../core/errors.ts';

/** The signals a stopping program gets, in order, after its stdin closes. */
export const STOP_SIGNALS = ['SIGTERM', 'SIGKILL'] as const;
/** One of the signals a stopping program gets. */
export type StopSignal = (typeof STOP_SIGNALS)[number];

/** What starts one stdio program. */
export interface ChildSpec {
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
 * This one spawns with the env as given, and an argument array with no shell. The router's instances and the worker
 * program's own servers both run over it.
 */
export class ChildTransport implements Transport {
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
export function signalDirectly(child: ChildProcessWithoutNullStreams, signal: StopSignal): Promise<void> {
  child.kill(signal);
  return Promise.resolve();
}
