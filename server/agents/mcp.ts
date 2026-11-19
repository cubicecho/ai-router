import { type RunEvent, RunEventKind } from '@cubicecho/agent-core';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  CancelledNotificationSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode as McpErrorCode,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import express, { type Request, type Response, type Router } from 'express';
import { ConflictingKeysError } from '../auth/caller.ts';
import { version } from '../core/config.ts';
import type { WorkspaceCaller } from '../core/context.ts';
import { RUN_DEFAULTS } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import { HttpStatus } from '../core/wire.ts';
import type { SnapshotHost } from '../db/snapshot.ts';
import { RunStatus } from '../db/tables/runs.ts';
import type { Forwarder } from '../models/forward.ts';
import { appCaller } from './app-caller.ts';
import { readConversationKey } from './conversation.ts';
import { UnreadableAgentError } from './layers.ts';
import { RequestRefusal, readRunRequest } from './request.ts';
import { RunConflict, type RunListener, type RunService } from './run.ts';
import { beginRun, type RunnableAgent, runnableAgent, runnableAgents } from './start.ts';

/** What the door calls itself to an MCP client. */
const SERVER_NAME = 'ai-router-agents';
/** JSON-RPC's code for a request the server refuses before reading it, as the SDK's own examples use. */
const JSON_RPC_REFUSED = -32_000;
/** The events an MCP client is told about as progress: the steps a person follows a run by. */
const PROGRESS_KINDS: ReadonlySet<string> = new Set([
  RunEventKind.Turn,
  RunEventKind.ToolCall,
  RunEventKind.ToolResult,
  RunEventKind.Notice,
]);

/** What every agent's tool takes. */
const INPUT_SCHEMA: Tool['inputSchema'] = {
  type: 'object',
  properties: {
    message: { type: 'string', description: 'What to ask the agent.' },
    conversation: {
      type: 'string',
      description:
        'A name for the conversation this message belongs to, of your choosing. The router keeps its history, so a later call with the same name carries it on. Left out, the agent starts afresh.',
    },
  },
  required: ['message'],
  additionalProperties: false,
};

/** What the agents door talks to. */
export interface AgentMcpDeps {
  snapshot: SnapshotHost;
  runs: RunService;
  forwarder: Forwarder;
  /** The clock keys' expiry is judged by. */
  now?: () => Date;
}

/** A request that got past the key check: who it is from. */
interface AppLocals {
  caller: WorkspaceCaller;
}

/**
 * Answers in JSON-RPC's error envelope, before the MCP server reads the request.
 *
 * @param response - The answer.
 * @param status - The HTTP status.
 * @param message - What the client is told.
 */
function refuse(response: Response, status: HttpStatus, message: string): void {
  response.status(status).json({ jsonrpc: '2.0', error: { code: JSON_RPC_REFUSED, message }, id: null });
}

/**
 * Describes an agent as its tool.
 *
 * @param agent - The agent.
 * @returns Its tool: named for the agent, described by its document.
 */
function toolOf(agent: RunnableAgent): Tool {
  const { name, description } = agent.document;
  const title = typeof name === 'string' ? name : agent.name;
  const said = typeof description === 'string' && description !== '' ? `${description}\n\n` : '';
  return {
    name: agent.name,
    title,
    description: `${said}Runs the ${title} agent on the message and answers with what it says. Each call is a run of its own, recorded on the router.`,
    inputSchema: INPUT_SCHEMA,
  };
}

/**
 * Says what a run's event is, as a progress message.
 *
 * @param event - The event.
 * @returns A line, or null for an event that is not a step.
 */
function progressMessage(event: RunEvent): string | null {
  if (PROGRESS_KINDS.has(event.kind) === false) {
    return null;
  }
  if (event.kind === RunEventKind.ToolCall) {
    return `Calling ${event.name}`;
  }
  if (event.kind === RunEventKind.ToolResult) {
    return event.ok === false ? `${event.name} failed` : `${event.name} answered`;
  }
  if (event.kind === RunEventKind.Turn) {
    return 'Thinking';
  }
  return event.text;
}

/**
 * Names a tool call across requests: a client numbers its own, so the id is read within its key.
 *
 * @param caller - The key the call came with.
 * @param requestId - The call's JSON-RPC id.
 * @returns The name.
 */
function callKey(caller: WorkspaceCaller, requestId: string | number): string {
  return JSON.stringify([caller.keyId, requestId]);
}

/**
 * Builds a tool's failed result.
 *
 * @param text - Why.
 * @returns The result, marked as an error so the client's model reads it as one.
 */
function failed(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Builds the agents door: `/mcp`, where an MCP client with a workspace key finds each agent that workspace may run as
 * a tool. Stateless: every request is answered on its own.
 *
 * @param deps - The snapshot, the run service and the forwarder.
 * @returns The router, to mount at `/mcp`.
 */
export function createAgentMcpRoutes({ snapshot, runs, forwarder, now = () => new Date() }: AgentMcpDeps): Router {
  const router = express.Router();
  /** The tool calls going, by key and JSON-RPC id: what a client's cancel aborts. */
  const calls = new Map<string, AbortController>();

  /**
   * Runs an agent for one tool call.
   *
   * @param caller - The key's workspace.
   * @param name - The tool, which is the agent's name.
   * @param args - What the call sent.
   * @param signal - Aborted when the client cancels the call or leaves: the run is cancelled.
   * @param progress - Tells the client of a step, when it asked for progress.
   * @returns The agent's answer, or why there is none.
   * @throws {@link McpError} For an agent the key may not run, or a call without a message.
   */
  const callAgent = async (
    caller: WorkspaceCaller,
    name: string,
    args: unknown,
    signal: AbortSignal,
    progress: (message: string, at: number) => void,
  ): Promise<CallToolResult> => {
    const current = snapshot.current();
    const workspace = current.workspaces.get(caller.workspaceId);
    const agent = runnableAgent(current.agents, caller.workspaceId, name);
    if (agent === null || workspace === undefined) {
      throw new McpError(McpErrorCode.InvalidParams, `There is no agent named "${name}" for this key.`);
    }
    const fields: Record<string, unknown> = isRecord(args) ? args : {};
    const { message, conversation: conversationName } = fields;
    if (typeof message !== 'string' || message.trim() === '') {
      throw new McpError(McpErrorCode.InvalidParams, 'message: say what to ask the agent.');
    }
    const body = { model: agent.name, messages: [{ role: 'user', content: message }] };
    let started: Awaited<ReturnType<typeof beginRun>>;
    try {
      const request = readRunRequest(body, agent.policy, current.settings);
      const key = readConversationKey(typeof conversationName === 'string' ? conversationName : undefined);
      const conversation = key === null ? null : await runs.openConversation(workspace.id, agent, key);
      started = await beginRun(runs, forwarder, current, {
        workspace,
        agent,
        request,
        conversation,
        idempotency: null,
      });
    } catch (error) {
      const isRefused =
        error instanceof RequestRefusal || error instanceof RunConflict || error instanceof UnreadableAgentError;
      if (isRefused) {
        return failed(error.message);
      }
      throw error;
    }
    if (started.kind === 'repeated') {
      // Only an Idempotency-Key repeats a run, and this door sends none.
      throw new Error('A tool call found a run it did not start.');
    }
    const listener: RunListener = {
      onText: () => {},
      onEvent: (event) => {
        const said = progressMessage(event);
        if (said !== null) {
          progress(said, event.seq);
        }
      },
    };
    const finished = await started.execute(listener, signal);
    const runNote = `Run ${finished.runId}.`;
    if (finished.status !== RunStatus.Completed) {
      return failed(
        `The run ${finished.status === RunStatus.Cancelled ? 'was cancelled' : 'failed'}: ${finished.error ?? ''} ${runNote}`,
      );
    }
    const answer = finished.answer?.content ?? '';
    return {
      content: [{ type: 'text', text: answer === '' ? '(The agent wrote nothing.)' : answer }],
      _meta: { runId: finished.runId },
    };
  };

  /**
   * Builds the MCP server for one request, over the key's workspace.
   *
   * @param caller - The key's workspace.
   * @param left - Aborted when the client's connection closes.
   * @returns The server, not yet connected.
   */
  const serverFor = (caller: WorkspaceCaller, left: AbortSignal): Server => {
    const server = new Server(
      { name: SERVER_NAME, version: version() },
      { capabilities: { tools: { listChanged: false } } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: runnableAgents(snapshot.current(), caller.workspaceId).map(toolOf),
    }));
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
      const progressToken = request.params._meta?.progressToken;
      const progress = (message: string, at: number) => {
        if (progressToken === undefined) {
          return;
        }
        extra
          .sendNotification({ method: 'notifications/progress', params: { progressToken, progress: at, message } })
          .catch((error: unknown) => console.warn(`[mcp] could not send progress: ${errorMessage(error)}`));
      };
      // Stateless, a client's cancel arrives as a request of its own, so the call is found again by its key and id.
      const call = callKey(caller, extra.requestId);
      const cancelled = new AbortController();
      calls.set(call, cancelled);
      const signal = AbortSignal.any([extra.signal, left, cancelled.signal]);
      return callAgent(caller, request.params.name, request.params.arguments, signal, progress).finally(() => {
        calls.delete(call);
      });
    });
    server.setNotificationHandler(CancelledNotificationSchema, (notification) => {
      const { requestId } = notification.params;
      if (requestId !== undefined) {
        calls.get(callKey(caller, requestId))?.abort();
      }
    });
    return server;
  };

  router.use((request: Request, response: Response<unknown, AppLocals>, next) => {
    let caller: WorkspaceCaller | null;
    try {
      caller = appCaller(snapshot.current(), request, now());
    } catch (error) {
      if (error instanceof ConflictingKeysError) {
        refuse(response, HttpStatus.BadRequest, error.message);
        return;
      }
      throw error;
    }
    if (caller === null) {
      refuse(response, HttpStatus.Unauthorized, 'Send a workspace key as Authorization: Bearer, or x-api-key.');
      return;
    }
    response.locals.caller = caller;
    next();
  });
  router.use(express.json({ limit: RUN_DEFAULTS.bodyLimit }));

  router.post('/', async (request: Request, response: Response<unknown, AppLocals>) => {
    const left = new AbortController();
    const server = serverFor(response.locals.caller, left.signal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on('close', () => {
      // A client that leaves mid-call cancels its run, as one without an Idempotency-Key does on /v1.
      left.abort();
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  });

  router.all('/', (_request: Request, response: Response) => {
    // Stateless: there is no session to follow with GET or end with DELETE.
    refuse(response, HttpStatus.MethodNotAllowed, 'This MCP server is stateless: POST each request.');
  });

  return router;
}
