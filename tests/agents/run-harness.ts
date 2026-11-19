import { mkdtemp, realpath, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@cubicecho/agent-core';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { createRunService, type RunService } from '../../server/agents/run.ts';
import { fixedAuthHost } from '../../server/auth/auth-host.ts';
import type { UserCaller } from '../../server/core/context.ts';
import type { RunSettings } from '../../server/core/defaults.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { createSnapshotHost, type SnapshotHost } from '../../server/db/snapshot.ts';
import { type RunStatus, runs } from '../../server/db/tables/runs.ts';
import { Role } from '../../server/db/tables/users.ts';
import { createApp } from '../../server/http/app.ts';
import type { UpstreamFetch, UpstreamResponse } from '../../server/models/outbound.ts';
import { createModelServices, type ModelServices } from '../../server/models/services.ts';
import { ChildMode } from '../../server/tools/child-users.ts';
import { createToolServices, type ToolServiceParts } from '../../server/tools/services.ts';
import {
  closeTestDb,
  createClient,
  createTestAuth,
  createTestDb,
  createUser,
  createWorkspaceWithKey,
  portOf,
  resetTestDb,
  type TestClient,
  type TestDb,
} from '../helpers.ts';

// The router end to end for the agents tests: its /v1 and /runs, a fake provider reached through the models area's
// own fetch, and the stdio fixture as the agent's MCP server.

/** The stdio fixture, run with this process's node. */
export const FIXTURE = fileURLToPath(new URL('../tools/fixtures/stdio-server.ts', import.meta.url));
/** A server name with a `.`, which no OpenAI function name may hold. */
export const SERVER = 'fix.ture';
/** What the fixture's `echo` is called as, once the router has named it for the model. */
export const ECHO = 'fix_ture__echo';
export const PROVIDER_URL = 'http://fake.test/v1';
/** The context window the fake provider lists `m1` with. */
export const PROVIDER_CONTEXT_LENGTH = 32_768;
export const AGENT_PROMPT = 'You answer with what the tool said.';
export const QUESTION = { role: 'user', content: 'hello there' };

export const INSTALL = `mutation ($input: InstallServerInput!) { installServer(input: $input) { id name } }`;
export const CREATE_PROVIDER = 'mutation ($values: CreateProviderInput!) { createProvider(values: $values) { id } }';
export const CREATE_AGENT = 'mutation ($document: JSON!) { createAgent(document: $document) { id liveRevisionId } }';
export const GRANT = 'mutation ($v: CreateWorkspaceAgentInput!) { createWorkspaceAgent(values: $v) { id } }';
export const CREATE_ENTRY =
  'mutation ($values: CreateWorkspaceServerInput!) { createWorkspaceServer(values: $values) { id } }';

/** One tool call the fake model makes. */
export interface ScriptCall {
  name: string;
  args: Record<string, unknown>;
}

/** What the fake model answers one request with. */
export interface Reply {
  content?: string;
  call?: ScriptCall;
  /** Several calls in one turn, each under the id `call_<n>`, from 1. */
  calls?: ScriptCall[];
}

/** A message the fake model was sent. */
export interface SentMessage {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
}

/**
 * Writes one answer as an OpenAI chat completion stream.
 *
 * @param reply - What the model says.
 * @returns The stream's text.
 */
function sse(reply: Reply): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id: 'up', object: 'chat.completion.chunk', created: 0, model: 'm1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const parts: string[] = [];
  const calls = reply.calls ?? (reply.call === undefined ? [] : [reply.call]);
  if (calls.length > 0) {
    const toolCalls = calls.map((call, index) => ({
      index,
      // The same ids on every turn, as a server that counts from one does.
      id: `call_${index + 1}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    }));
    if (reply.content !== undefined) {
      parts.push(chunk({ role: 'assistant', content: reply.content }, null));
    }
    parts.push(chunk({ role: 'assistant', tool_calls: toolCalls }, null), chunk({}, 'tool_calls'));
  } else {
    const content = reply.content ?? '';
    const half = Math.ceil(content.length / 2);
    parts.push(
      chunk({ role: 'assistant', content: content.slice(0, half) }, null),
      chunk({ content: content.slice(half) }, null),
    );
    parts.push(chunk({}, 'stop'));
  }
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  parts.push(
    `data: ${JSON.stringify({ id: 'up', object: 'chat.completion.chunk', created: 0, model: 'm1', choices: [], usage })}\n\n`,
  );
  parts.push('data: [DONE]\n\n');
  return parts.join('');
}

/**
 * The newest message the fake model was sent.
 *
 * @param body - A request body.
 * @returns Its role and content.
 */
export function lastMessage(body: Record<string, unknown>): { role: string; content: string } {
  const messages = sentMessages(body);
  const last = messages.at(-1);
  return { role: String(last?.role ?? ''), content: typeof last?.content === 'string' ? last.content : '' };
}

/**
 * The messages a request to the fake model carried.
 *
 * @param body - A request body.
 * @returns Its messages.
 */
export function sentMessages(body: Record<string, unknown> | undefined): SentMessage[] {
  return Array.isArray(body?.messages) ? body.messages : [];
}

/**
 * The names of the tools a request to the fake model declared.
 *
 * @param body - A request body.
 * @returns The function names.
 */
export function sentToolNames(body: Record<string, unknown> | undefined): string[] {
  return (Array.isArray(body?.tools) ? body.tools : []).map(
    (tool: { function: { name: string } }) => tool.function.name,
  );
}

/** Calls `echo` with the question, then answers with what it said. */
export const ECHO_SCRIPT = (body: Record<string, unknown>): Reply => {
  const last = lastMessage(body);
  return last.role === 'tool'
    ? { content: `The tool said: ${last.content}` }
    : { call: { name: ECHO, args: { text: last.content } } };
};

/**
 * Reads an event stream's data lines.
 *
 * @param response - A streamed answer.
 * @returns Each `data:` payload, parsed, with `[DONE]` as the string.
 */
export async function dataLines(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .map((data) => (data === '[DONE]' ? data : JSON.parse(data)));
}

/**
 * Checks that events are in order with no repeat: their `seq`s only increase. Stored events have gaps where a stretch
 * of streamed text was folded into one, under its last event's `seq`.
 *
 * @param events - The events.
 */
export function expectInOrder(events: readonly { seq: number }[]): void {
  const seqs = events.map((event) => event.seq);
  const isIncreasing = seqs.every((seq, index) => index === 0 || seq > (seqs[index - 1] ?? seq));
  expect(isIncreasing).toBe(true);
}

/**
 * Waits until a condition holds.
 *
 * @param check - Asked every 20 ms.
 * @param [what] - What is waited for, for the failure.
 */
export async function until(check: () => boolean | Promise<boolean>, what = 'the condition'): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Waited too long for ${what}.`);
}

/** What a test file gets from the harness. The hooks `useRunHarness` registers fill in its fields. */
export class RunHarness {
  db!: TestDb;
  snapshot!: SnapshotHost;
  tools!: ToolServiceParts;
  models!: ModelServices;
  user!: UserCaller;
  asUser!: TestClient;
  workspaceId!: string;
  keySecret!: string;
  agentId!: string;
  revisionId!: string;
  /** The bodies the fake provider was sent, chat completions only. */
  received: Record<string, unknown>[] = [];
  /** Decides each answer of the fake model. */
  script: (body: Record<string, unknown>) => Reply = ECHO_SCRIPT;
  /** The routers started in this test, which the harness stops after it. */
  started: { server: Server; runs: RunService }[] = [];

  /** The fake provider, as the models area reaches it. */
  readonly provider: UpstreamFetch = async (url, request) => {
    const answer = (status: number, text: string, isStream = false): UpstreamResponse => ({
      status,
      ok: status < HttpStatus.BadRequest,
      headers: new Headers({ 'content-type': isStream ? 'text/event-stream' : 'application/json' }),
      body: isStream
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(text));
              controller.close();
            },
          })
        : null,
      text: async () => text,
    });
    if (url === `${PROVIDER_URL}/models`) {
      const data = [{ id: 'm1', object: 'model', max_model_len: PROVIDER_CONTEXT_LENGTH }];
      return answer(HttpStatus.Ok, JSON.stringify({ object: 'list', data }));
    }
    if (url !== `${PROVIDER_URL}/chat/completions`) {
      return answer(HttpStatus.NotFound, JSON.stringify({ error: { message: 'not here' } }));
    }
    const body: Record<string, unknown> = JSON.parse(request.body ?? '{}');
    this.received.push(body);
    return answer(HttpStatus.Ok, sse(this.script(body)), true);
  };

  /**
   * Starts the router on a real socket.
   *
   * @param [overrides] - Run settings that differ.
   * @returns Its address and run service.
   */
  async startRouter(overrides: Partial<RunSettings> = {}): Promise<{ base: string; runs: RunService }> {
    const runService = createRunService({
      db: this.db,
      snapshot: this.snapshot,
      tools: this.tools,
      runtime: createRuntime(),
      overrides,
    });
    const { app } = await createApp({
      db: this.db,
      authHost: fixedAuthHost(createTestAuth(this.db)),
      snapshot: this.snapshot,
      models: this.models,
      tools: this.tools,
      runs: runService,
      children: { mode: ChildMode.Shared, reason: '' },
    });
    const server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    this.started.push({ server, runs: runService });
    return { base: `http://127.0.0.1:${portOf(server)}`, runs: runService };
  }

  /**
   * Asks for a chat completion with the workspace's key.
   *
   * @param base - The router.
   * @param body - The request body.
   * @param [headers] - Extra headers, which may replace the key.
   * @returns The answer.
   */
  complete(base: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.keySecret}`, ...headers },
      body: JSON.stringify(body),
    });
  }

  /**
   * Reads a path of the router with the workspace's key.
   *
   * @param url - The whole URL.
   * @param [headers] - Extra headers, which may replace the key.
   * @returns The answer.
   */
  get(url: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(url, { headers: { authorization: `Bearer ${this.keySecret}`, ...headers } });
  }

  /**
   * Waits for a run to reach a status.
   *
   * @param runId - The run.
   * @param status - The status.
   * @returns The run's row.
   */
  async runReaches(runId: string, status: RunStatus): Promise<typeof runs.$inferSelect> {
    let found: typeof runs.$inferSelect | undefined;
    await until(async () => {
      [found] = await this.db.select().from(runs).where(eq(runs.id, runId));
      return found?.status === status;
    }, `run ${runId} to reach ${status}`);
    if (found === undefined) {
      throw new Error(`Run ${runId} is gone.`);
    }
    return found;
  }
}

/**
 * Sets up the router for a test file: a database for the file, and for each test a workspace with a key, the
 * fixture server, a fake provider and the `helper` agent, granted to the workspace.
 *
 * @returns The harness, whose fields the hooks fill in.
 */
export function useRunHarness(): RunHarness {
  const h = new RunHarness();
  let root = '';

  beforeAll(async () => {
    h.db = await createTestDb();
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-router-runs-')));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await closeTestDb(h.db);
  });

  beforeEach(async () => {
    await resetTestDb(h.db);
    h.received = [];
    h.script = ECHO_SCRIPT;
    h.user = await createUser(h.db, 'user@example.com', Role.User);
    h.snapshot = await createSnapshotHost(h.db);
    h.tools = createToolServices({
      db: h.db,
      snapshot: h.snapshot,
      isolation: { mode: ChildMode.Shared, reason: '' },
      folders: { root },
    });
    h.models = createModelServices({ db: h.db, snapshot: h.snapshot, fetch: h.provider });
    h.asUser = createClient(h.db, h.user, { snapshot: h.snapshot, tools: h.tools, models: h.models });
    ({ workspaceId: h.workspaceId, secret: h.keySecret } = await createWorkspaceWithKey(h.db, 'task-server'));
    await h.snapshot.rebuild();
    await h.asUser.expectOk(INSTALL, {
      input: {
        name: SERVER,
        source: { type: 'manual' },
        transport: { type: 'stdio', command: process.execPath, args: [FIXTURE] },
      },
    });
    await h.asUser.expectOk(CREATE_PROVIDER, { values: { name: 'fake', baseUrl: PROVIDER_URL } });
    const { createAgent } = await h.asUser.expectOk(CREATE_AGENT, {
      document: {
        spec: 'cubicecho.agent/1',
        id: 'helper',
        name: 'Helper',
        description: 'Answers with what its tool said.',
        model: { model: 'fake/m1', temperature: 0.2 },
        prompt: [{ id: 'role', text: AGENT_PROMPT }],
        tools: { servers: [SERVER], maxIterations: 4 },
      },
    });
    h.agentId = createAgent.id;
    h.revisionId = createAgent.liveRevisionId;
    await h.asUser.expectOk(GRANT, { v: { workspaceId: h.workspaceId, agentId: h.agentId } });
  });

  afterEach(async () => {
    for (const { server, runs: runService } of h.started) {
      await runService.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    h.started = [];
    await h.tools.stop();
  });

  return h;
}
