import { mkdtemp, realpath, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '@cubicecho/agent-core';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunService, type RunService } from '../../server/agents/run.ts';
import { fixedAuthHost } from '../../server/auth/auth-host.ts';
import type { UserCaller } from '../../server/core/context.ts';
import type { RunSettings } from '../../server/core/defaults.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { createSnapshotHost, type SnapshotHost } from '../../server/db/snapshot.ts';
import { activity } from '../../server/db/tables/activity.ts';
import { RunStatus, runs } from '../../server/db/tables/runs.ts';
import { usageCounts } from '../../server/db/tables/usage-counts.ts';
import { Role } from '../../server/db/tables/users.ts';
import { createApp } from '../../server/http/app.ts';
import type { UpstreamFetch, UpstreamResponse } from '../../server/models/outbound.ts';
import { createModelServices, type ModelServices } from '../../server/models/services.ts';
import { ChildMode } from '../../server/tools/child-users.ts';
import { createToolServices, type ToolServiceParts } from '../../server/tools/services.ts';
import {
  closeTestDb,
  createClient,
  createSessionToken,
  createTestAuth,
  createTestDb,
  createUser,
  createWorkspaceWithKey,
  portOf,
  resetTestDb,
  type TestClient,
  type TestDb,
} from '../helpers.ts';

// A workspace key runs an agent end to end: the router's /v1, a fake provider reached through the models area's
// own fetch, and the stdio fixture as the agent's MCP server.

/** The stdio fixture, run with this process's node. */
const FIXTURE = fileURLToPath(new URL('../tools/fixtures/stdio-server.ts', import.meta.url));
/** A server name with a `.`, which no OpenAI function name may hold. */
const SERVER = 'fix.ture';
/** What the fixture's `echo` is called as, once the router has named it for the model. */
const ECHO = 'fix_ture__echo';
const PROVIDER_URL = 'http://fake.test/v1';
const AGENT_PROMPT = 'You answer with what the tool said.';

const INSTALL = `mutation ($input: InstallServerInput!) { installServer(input: $input) { id name } }`;
const CREATE_PROVIDER = 'mutation ($values: CreateProviderInput!) { createProvider(values: $values) { id } }';
const CREATE_AGENT = 'mutation ($document: JSON!) { createAgent(document: $document) { id liveRevisionId } }';
const GRANT = 'mutation ($v: CreateWorkspaceAgentInput!) { createWorkspaceAgent(values: $v) { id } }';
const CREATE_ENTRY =
  'mutation ($values: CreateWorkspaceServerInput!) { createWorkspaceServer(values: $values) { id } }';

/** What the fake model answers one request with. */
interface Reply {
  content?: string;
  call?: { name: string; args: Record<string, unknown> };
}

/** The bodies the fake provider was sent, chat completions only. */
let received: Record<string, unknown>[];
/** Decides each answer of the fake model. */
let script: (body: Record<string, unknown>) => Reply;

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
  if (reply.call !== undefined) {
    const call = {
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) },
    };
    parts.push(chunk({ role: 'assistant', tool_calls: [call] }, null), chunk({}, 'tool_calls'));
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

/** The fake provider, as the models area reaches it. */
const fakeProvider: UpstreamFetch = async (url, request) => {
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
    return answer(HttpStatus.Ok, JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }] }));
  }
  if (url !== `${PROVIDER_URL}/chat/completions`) {
    return answer(HttpStatus.NotFound, JSON.stringify({ error: { message: 'not here' } }));
  }
  const body: Record<string, unknown> = JSON.parse(request.body ?? '{}');
  received.push(body);
  return answer(HttpStatus.Ok, sse(script(body)), true);
};

/**
 * The text of the newest message the fake model was sent.
 *
 * @param body - A request body.
 * @returns Its role and content.
 */
function lastMessage(body: Record<string, unknown>): { role: string; content: string } {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages.at(-1);
  return { role: String(last?.role ?? ''), content: typeof last?.content === 'string' ? last.content : '' };
}

/** Calls `echo` with the question, then answers with what it said. */
const ECHO_SCRIPT = (body: Record<string, unknown>): Reply => {
  const last = lastMessage(body);
  return last.role === 'tool'
    ? { content: `The tool said: ${last.content}` }
    : { call: { name: ECHO, args: { text: last.content } } };
};

let db: TestDb;
let root: string;
let snapshot: SnapshotHost;
let tools: ToolServiceParts;
let models: ModelServices;
let user: UserCaller;
let asUser: TestClient;
let workspaceId: string;
let keySecret: string;
let agentId: string;
let revisionId: string;
let open: { server: Server; base: string; runs: RunService }[] = [];

/**
 * Starts the router on a real socket.
 *
 * @param [overrides] - Run settings that differ.
 * @returns Its address and run service.
 */
async function startRouter(overrides: Partial<RunSettings> = {}): Promise<{ base: string; runs: RunService }> {
  const runService = createRunService({ db, snapshot, tools, runtime: createRuntime(), overrides });
  const { app } = await createApp({
    db,
    authHost: fixedAuthHost(createTestAuth(db)),
    snapshot,
    models,
    tools,
    runs: runService,
    children: { mode: ChildMode.Shared, reason: '' },
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const started = { server, base: `http://127.0.0.1:${portOf(server)}`, runs: runService };
  open.push(started);
  return started;
}

/**
 * Asks for a chat completion with the workspace's key.
 *
 * @param base - The router.
 * @param body - The request body.
 * @param [headers] - Extra headers.
 * @returns The answer.
 */
function complete(
  base: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${keySecret}`, ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * Reads an event stream's data lines.
 *
 * @param response - A streamed answer.
 * @returns Each `data:` payload, parsed, with `[DONE]` as the string.
 */
async function dataLines(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .map((data) => (data === '[DONE]' ? data : JSON.parse(data)));
}

/**
 * Waits for a run to reach a status.
 *
 * @param runId - The run.
 * @param status - The status.
 * @returns The run's row.
 */
async function runReaches(runId: string, status: RunStatus) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await db.select().from(runs).where(eq(runs.id, runId));
    if (row?.status === status) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Run ${runId} never reached ${status}.`);
}

const QUESTION = { role: 'user', content: 'hello there' };

beforeAll(async () => {
  db = await createTestDb();
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'ai-router-runs-')));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await closeTestDb(db);
});

beforeEach(async () => {
  await resetTestDb(db);
  received = [];
  script = ECHO_SCRIPT;
  user = await createUser(db, 'user@example.com', Role.User);
  snapshot = await createSnapshotHost(db);
  tools = createToolServices({ db, snapshot, isolation: { mode: ChildMode.Shared, reason: '' }, folders: { root } });
  models = createModelServices({ db, snapshot, fetch: fakeProvider });
  asUser = createClient(db, user, { snapshot, tools, models });
  ({ workspaceId, secret: keySecret } = await createWorkspaceWithKey(db, 'task-server'));
  await snapshot.rebuild();
  await asUser.expectOk(INSTALL, {
    input: {
      name: SERVER,
      source: { type: 'manual' },
      transport: { type: 'stdio', command: process.execPath, args: [FIXTURE] },
    },
  });
  await asUser.expectOk(CREATE_PROVIDER, { values: { name: 'fake', baseUrl: PROVIDER_URL } });
  const { createAgent } = await asUser.expectOk(CREATE_AGENT, {
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
  agentId = createAgent.id;
  revisionId = createAgent.liveRevisionId;
  await asUser.expectOk(GRANT, { v: { workspaceId, agentId } });
});

afterEach(async () => {
  for (const { server, runs: runService } of open) {
    await runService.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  open = [];
  await tools.stop();
});

describe('the agents endpoint', () => {
  it('lists the agents this key may run, marked as agents', async () => {
    const { base } = await startRouter();
    await asUser.expectOk(CREATE_AGENT, {
      document: { spec: 'cubicecho.agent/1', id: 'not-granted', model: { model: 'fake/m1' }, tools: { servers: [] } },
    });
    const response = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${keySecret}` } });
    expect(response.status).toBe(HttpStatus.Ok);
    expect(await response.json()).toEqual({
      object: 'list',
      data: [
        {
          id: 'helper',
          object: 'model',
          created: 0,
          owned_by: 'ai-router',
          name: 'Helper',
          description: 'Answers with what its tool said.',
          ai_router: { kind: 'agent' },
        },
      ],
    });
    const one = await fetch(`${base}/v1/models/helper`, { headers: { 'x-api-key': keySecret } });
    expect(await one.json()).toMatchObject({ id: 'helper' });
    const hidden = await fetch(`${base}/v1/models/not-granted`, { headers: { 'x-api-key': keySecret } });
    expect(hidden.status).toBe(HttpStatus.NotFound);
  });

  it('takes workspace keys only: no key, a session, or two different keys are refused', async () => {
    const { base } = await startRouter();
    const none = await fetch(`${base}/v1/models`);
    expect(none.status).toBe(HttpStatus.Unauthorized);
    expect(await none.json()).toMatchObject({ error: { code: 'invalid_api_key', type: 'invalid_request_error' } });
    const session = await createSessionToken(createTestAuth(db), user.userId);
    const asPerson = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${session}` } });
    expect(asPerson.status).toBe(HttpStatus.Unauthorized);
    vi.stubEnv('SECURE_LOCAL_NET', 'true');
    try {
      expect((await fetch(`${base}/v1/models`)).status).toBe(HttpStatus.Unauthorized);
    } finally {
      vi.unstubAllEnvs();
    }
    const both = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${keySecret}`, 'x-api-key': 'air_other' },
    });
    expect(both.status).toBe(HttpStatus.BadRequest);
  });

  it('answers 404 in the OpenAI envelope for other paths, and the same 404 for an unknown or ungranted agent', async () => {
    const { base } = await startRouter();
    const other = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${keySecret}` },
    });
    expect(other.status).toBe(HttpStatus.NotFound);
    expect(await other.json()).toMatchObject({ error: { code: 'not_found' } });
    await asUser.expectOk(CREATE_AGENT, {
      document: { spec: 'cubicecho.agent/1', id: 'private', model: { model: 'fake/m1' }, tools: { servers: [] } },
    });
    const unknown = await complete(base, { model: 'nobody', messages: [QUESTION] });
    const ungranted = await complete(base, { model: 'private', messages: [QUESTION] });
    expect(unknown.status).toBe(HttpStatus.NotFound);
    expect(ungranted.status).toBe(HttpStatus.NotFound);
    const [a, b] = [await unknown.json(), await ungranted.json()];
    expect(a.error.code).toBe('model_not_found');
    expect(b.error).toEqual({ ...a.error, message: a.error.message.replace('nobody', 'private') });
    expect(unknown.headers.get('x-run-id')).toBeNull();
    expect(await db.select().from(runs)).toEqual([]);
  });

  it('runs the agent: its model calls an MCP tool from the stub server, and the run answers and is recorded', async () => {
    const { base } = await startRouter();
    const response = await complete(base, {
      model: 'helper',
      messages: [{ role: 'system', content: 'You are in task_server.' }, QUESTION],
      ai_router: { task: 'Say what the tool says.' },
      temperature: 0.9,
      top_k: 40,
      user: 'household-a',
    });
    expect(response.status).toBe(HttpStatus.Ok);
    const runId = response.headers.get('x-run-id');
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    const answer = await response.json();
    expect(answer).toMatchObject({
      id: `chatcmpl-${runId}`,
      object: 'chat.completion',
      model: 'helper',
      choices: [
        { index: 0, message: { role: 'assistant', content: 'The tool said: hello there' }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
    // What the model was sent: the layers in order, the request's sampling by name, the tool under a valid name.
    const [first] = received;
    expect(first?.model).toBe('m1');
    expect(first?.temperature).toBe(0.9);
    expect(first?.top_k).toBe(40);
    const messages = Array.isArray(first?.messages) ? first.messages : [];
    expect(messages[0]).toEqual({
      role: 'system',
      content: `${AGENT_PROMPT}\n\nYou are in task_server.\n\nSay what the tool says.`,
    });
    expect(messages.slice(1)).toEqual([QUESTION]);
    const names = (Array.isArray(first?.tools) ? first.tools : []).map((tool) => tool.function.name);
    expect(names).toContain(ECHO);
    expect(names.every((name: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(name))).toBe(true);

    const [row] = await db.select().from(runs);
    expect(row).toMatchObject({
      id: runId,
      workspaceId,
      workspaceName: 'task-server',
      agentId,
      agentName: 'helper',
      revisionId,
      status: RunStatus.Completed,
      user: 'household-a',
      stream: false,
      inputTokens: 20,
      outputTokens: 10,
      error: null,
      answer: { content: 'The tool said: hello there', finishReason: 'stop' },
    });
    expect(row?.finishedAt).toBeInstanceOf(Date);

    // Usage counts under the run's workspace and agent, and the tool call under its run.
    await models.usage.flush();
    expect(await db.select().from(usageCounts)).toEqual([
      expect.objectContaining({
        workspaceId,
        workspaceName: 'task-server',
        agentId,
        agentName: 'helper',
        model: 'm1',
        requests: 2,
      }),
    ]);
    await tools.activity.flush();
    expect(await db.select().from(activity)).toEqual([
      expect.objectContaining({
        serverName: SERVER,
        tool: 'echo',
        ok: true,
        runId,
        agentId,
        agentName: 'helper',
        workspaceId,
      }),
    ]);
  });

  it('streams the answer as chunks, with the usage chunk when asked', async () => {
    const { base } = await startRouter();
    const response = await complete(base, {
      model: 'helper',
      messages: [QUESTION],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const runId = response.headers.get('x-run-id');
    const lines = await dataLines(response);
    expect(lines.at(-1)).toBe('[DONE]');
    const chunks = lines.slice(0, -1) as {
      object: string;
      id: string;
      choices: { delta: { content?: string }; finish_reason: string | null }[];
      usage?: unknown;
    }[];
    expect(chunks.every((chunk) => chunk.object === 'chat.completion.chunk' && chunk.id === `chatcmpl-${runId}`)).toBe(
      true,
    );
    const text = chunks.flatMap((chunk) => chunk.choices.map((choice) => choice.delta.content ?? '')).join('');
    expect(text).toBe('The tool said: hello there');
    expect(chunks.at(-2)?.choices[0]?.finish_reason).toBe('stop');
    expect(chunks.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
    const plain = await dataLines(await complete(base, { model: 'helper', messages: [QUESTION], stream: true }));
    expect(plain.some((line) => typeof line === 'object' && line !== null && 'usage' in line)).toBe(false);
  });

  it('refuses what the override policy refuses, before any run is recorded', async () => {
    const { base } = await startRouter();
    const cases: [Record<string, unknown>, string][] = [
      [{ logit_bias: { 50256: -100 } }, 'logit_bias'],
      [{ repeat_penalty: 1.1 }, 'repeat_penalty'],
      [{ n: 2 }, 'n'],
      [{ tools: [{ type: 'function', function: { name: 'ask_user', parameters: {} } }] }, 'tools'],
    ];
    for (const [extra, param] of cases) {
      const response = await complete(base, { model: 'helper', messages: [QUESTION], ...extra });
      expect(response.status).toBe(HttpStatus.BadRequest);
      const { error } = await response.json();
      expect(error).toMatchObject({ type: 'invalid_request_error', param });
      expect(error.message).toContain(param);
    }
    expect(await db.select().from(runs)).toEqual([]);
    expect(received).toEqual([]);
  });

  it('runs a workspace instance with its own settings when the workspace has an entry for the server', async () => {
    const [server] = await asUser.expectOk('{ servers { id name } }').then((data) => data.servers);
    await asUser.expectOk(CREATE_ENTRY, {
      values: { workspaceId, serverId: server.id, env: { FIXTURE_GREETING: 'household a' } },
    });
    script = (body) => {
      const last = lastMessage(body);
      return last.role === 'tool' ? { content: last.content } : { call: { name: 'fix_ture__env', args: {} } };
    };
    const { base } = await startRouter();
    const answer = await (await complete(base, { model: 'helper', messages: [QUESTION] })).json();
    expect(JSON.parse(answer.choices[0].message.content).FIXTURE_GREETING).toBe('household a');
  });

  it('leaves out a server that fails to start, and says so, without failing the run', async () => {
    await asUser.expectOk(INSTALL, {
      input: {
        name: 'broken',
        source: { type: 'manual' },
        transport: { type: 'stdio', command: process.execPath, args: [FIXTURE, '--die-at-start'] },
      },
    });
    const { createAgent } = await asUser.expectOk(CREATE_AGENT, {
      document: { spec: 'cubicecho.agent/1', id: 'everything', model: { model: 'fake/m1' } },
    });
    await asUser.expectOk(GRANT, { v: { workspaceId, agentId: createAgent.id } });
    const { base, runs: runService } = await startRouter();
    const response = await complete(base, { model: 'everything', messages: [QUESTION] });
    expect(response.status).toBe(HttpStatus.Ok);
    const names = (Array.isArray(received[0]?.tools) ? received[0].tools : []).map((tool) => tool.function.name);
    expect(names).toContain(ECHO);
    expect(names.some((name: string) => name.startsWith('broken__'))).toBe(false);
    const events = runService.bus.history(response.headers.get('x-run-id') ?? '');
    expect(events.some((event) => event.kind === 'notice' && event.text.includes('"broken"'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'done', ok: true });
  });
});

describe('Idempotency-Key', () => {
  it('replays a finished run instead of starting another, streamed or not as asked', async () => {
    const { base } = await startRouter();
    const body = { model: 'helper', messages: [QUESTION] };
    const first = await complete(base, body, { 'idempotency-key': 'friday-1' });
    const runId = first.headers.get('x-run-id');
    const firstAnswer = await first.json();
    const again = await complete(base, body, { 'idempotency-key': 'friday-1' });
    expect(again.headers.get('x-run-id')).toBe(runId);
    expect(await again.json()).toEqual(firstAnswer);
    const streamed = await complete(base, { ...body, stream: true }, { 'idempotency-key': 'friday-1' });
    expect(streamed.headers.get('x-run-id')).toBe(runId);
    const lines = await dataLines(streamed);
    const text = (lines.slice(0, -1) as { choices: { delta: { content?: string } }[] }[])
      .flatMap((chunk) => chunk.choices.map((choice) => choice.delta.content ?? ''))
      .join('');
    expect(text).toBe('The tool said: hello there');
    expect(await db.select({ id: runs.id }).from(runs)).toEqual([{ id: runId }]);
    expect(received).toHaveLength(2);
  });

  it('answers 422 for the same key with a different body', async () => {
    const { base } = await startRouter();
    await (await complete(base, { model: 'helper', messages: [QUESTION] }, { 'idempotency-key': 'k' })).json();
    const changed = await complete(
      base,
      { model: 'helper', messages: [{ role: 'user', content: 'other' }] },
      { 'idempotency-key': 'k' },
    );
    expect(changed.status).toBe(HttpStatus.UnprocessableEntity);
    expect(await changed.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } });
    expect(changed.headers.get('x-run-id')).not.toBeNull();
  });

  it('waits for a run still going with that key, then replays it', async () => {
    script = (body) => {
      const last = lastMessage(body);
      return last.role === 'tool'
        ? { content: 'slept well' }
        : { call: { name: 'fix_ture__sleep', args: { ms: 400 } } };
    };
    const { base } = await startRouter();
    const body = { model: 'helper', messages: [QUESTION] };
    const [one, two] = await Promise.all([
      complete(base, body, { 'idempotency-key': 'once' }),
      new Promise((resolve) => setTimeout(resolve, 100)).then(() =>
        complete(base, body, { 'idempotency-key': 'once' }),
      ),
    ]);
    expect(two.headers.get('x-run-id')).toBe(one.headers.get('x-run-id'));
    expect((await two.json()).choices[0].message.content).toBe('slept well');
    expect((await one.json()).choices[0].message.content).toBe('slept well');
    expect(await db.select({ id: runs.id }).from(runs)).toHaveLength(1);
  });

  it('keeps keys apart per workspace', async () => {
    const other = await createWorkspaceWithKey(db, 'min-agent');
    await asUser.expectOk(GRANT, { v: { workspaceId: other.workspaceId, agentId } });
    const { base } = await startRouter();
    const body = { model: 'helper', messages: [QUESTION] };
    const mine = await complete(base, body, { 'idempotency-key': 'same' });
    const theirs = await complete(base, body, { 'idempotency-key': 'same', authorization: `Bearer ${other.secret}` });
    expect(theirs.headers.get('x-run-id')).not.toBe(mine.headers.get('x-run-id'));
  });
});

describe("a run's end", () => {
  it('is cancelled when the app disconnects', async () => {
    script = () => ({ call: { name: 'fix_ture__sleep', args: { ms: 5_000 } } });
    const { base } = await startRouter();
    const response = await complete(base, { model: 'helper', messages: [QUESTION], stream: true }, {});
    const runId = response.headers.get('x-run-id') ?? '';
    // Wait for the tool call, then hang up.
    while (received.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await response.body?.cancel();
    const row = await runReaches(runId, RunStatus.Cancelled);
    expect(row.error).toBe('The app disconnected.');
  });

  it('fails at the run timeout', async () => {
    script = () => ({ call: { name: 'fix_ture__sleep', args: { ms: 5_000 } } });
    const { base } = await startRouter({ timeoutMinutes: 0.005 });
    const response = await complete(base, { model: 'helper', messages: [QUESTION] });
    expect(response.status).toBe(HttpStatus.InternalServerError);
    expect(await response.json()).toMatchObject({ error: { code: 'run_failed' } });
    const [row] = await db.select().from(runs);
    expect(row).toMatchObject({ status: RunStatus.Failed, error: 'The run took longer than 0.005 minutes.' });
    const streamed = await dataLines(await complete(base, { model: 'helper', messages: [QUESTION], stream: true }));
    expect(streamed.at(-1)).toMatchObject({ error: { code: 'run_failed' } });
  });

  it('fails a run left running by a restart, and prunes old runs and spent keys', async () => {
    const values = { workspaceId, workspaceName: 'task-server', agentId, agentName: 'helper', stream: false };
    const [left] = await db
      .insert(runs)
      .values({ ...values, status: RunStatus.Running })
      .returning();
    const long = new Date(Date.now() - 40 * 86_400_000);
    const yesterday = new Date(Date.now() - 2 * 86_400_000);
    await db.insert(runs).values({ ...values, status: RunStatus.Completed, startedAt: long, finishedAt: long });
    const [recent] = await db
      .insert(runs)
      .values({
        ...values,
        status: RunStatus.Completed,
        idempotencyKey: 'old',
        requestHash: 'h',
        finishedAt: yesterday,
      })
      .returning();
    const runService = createRunService({ db, snapshot, tools });
    expect(await runService.recover()).toBe(1);
    const [recovered] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, left?.id ?? ''));
    expect(recovered).toMatchObject({
      status: RunStatus.Failed,
      error: 'The router restarted while the run was going.',
    });
    await runService.prune();
    const kept = await db.select().from(runs);
    expect(kept.map((row) => row.id).sort()).toEqual([left?.id, recent?.id].sort());
    expect(kept.find((row) => row.id === recent?.id)).toMatchObject({ idempotencyKey: null, requestHash: null });
  });
});

describe('the runEvents subscription', () => {
  it("streams a run's events to a person, and refuses a key", async () => {
    const { base } = await startRouter();
    const response = await complete(base, { model: 'helper', messages: [QUESTION] });
    const runId = response.headers.get('x-run-id');
    await response.json();
    const session = await createSessionToken(createTestAuth(db), user.userId);
    const subscribe = (credential: string) =>
      fetch(`${base}/graphql`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify({ query: `subscription { runEvents(runId: "${runId}") { runId seq kind name ok } }` }),
      });
    const followed = await subscribe(session);
    expect(followed.headers.get('content-type')).toContain('text/event-stream');
    const events = (await followed.text())
      .split('\n')
      .filter((line) => line.startsWith('data: ') && line.includes('runEvents'))
      .map((line) => JSON.parse(line.slice('data: '.length)).data.runEvents);
    expect(events[0]).toMatchObject({ runId, seq: 1 });
    expect(events.some((event) => event.kind === 'tool-call' && event.name === ECHO)).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'done', ok: true });
    const refused = await (await subscribe(keySecret)).text();
    expect(refused).toContain('FORBIDDEN');
  });
});
