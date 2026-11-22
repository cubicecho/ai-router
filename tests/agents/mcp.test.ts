import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  CreateTaskResultSchema,
  RELATED_TASK_META_KEY,
} from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { isRecord } from '../../server/core/is-record.ts';
import { HttpStatus, RUN_EVENT_META_KEY } from '../../server/core/wire.ts';
import { RunStatus, runs } from '../../server/db/tables/runs.ts';
import { createWorkspaceWithKey } from '../helpers.ts';
import { ECHO, lastMessage, QUESTION, sentMessages, until, useRunHarness } from './run-harness.ts';

// /mcp offers each agent a workspace key may run as an MCP tool: a message in, the answer out, progress as MCP
// progress notifications, and every call a run recorded under the workspace.

const h = useRunHarness();

/** The clients a test opened, closed after it. */
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
});

/**
 * Connects an MCP client to the router's /mcp.
 *
 * @param base - The router.
 * @param [secret] - The key, the harness's own by default.
 * @returns The connected client.
 */
async function connect(base: string, secret = h.keySecret): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${secret}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

/**
 * Reads the text a tool answered with.
 *
 * @param result - The tool's result.
 * @returns Its first text part.
 */
function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const [first] = Array.isArray(result.content) ? result.content : [];
  return first?.type === 'text' ? first.text : '';
}

describe('/mcp', () => {
  it("lists the agents the key's workspace may run as tools, and refuses no key", async () => {
    const { base } = await h.startRouter();
    const { tools } = await (await connect(base)).listTools();
    expect(tools).toEqual([
      expect.objectContaining({
        name: 'helper',
        title: 'Helper',
        description: expect.stringContaining('Answers with what its tool said.'),
        inputSchema: expect.objectContaining({ required: ['message'] }),
      }),
    ]);

    const other = await createWorkspaceWithKey(h.db, 'min-agent');
    await h.snapshot.rebuild();
    expect((await (await connect(base, other.secret)).listTools()).tools).toEqual([]);

    const none = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(none.status).toBe(HttpStatus.Unauthorized);
    expect(await none.json()).toMatchObject({ jsonrpc: '2.0', error: { message: expect.stringContaining('key') } });
  });

  it('runs the agent on the message, with progress, as a run recorded under the workspace', async () => {
    const { base } = await h.startRouter();
    const client = await connect(base);
    const steps: string[] = [];
    const result = await client.callTool({ name: 'helper', arguments: { message: 'hello there' } }, undefined, {
      onprogress: (progress) => steps.push(progress.message ?? ''),
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('The tool said: hello there');
    expect(steps).toContain('Calling fix_ture__echo');

    const [row] = await h.db.select().from(runs);
    expect(row).toMatchObject({ workspaceId: h.workspaceId, agentName: 'helper', status: RunStatus.Completed });
    expect(row?.input).toEqual([QUESTION]);
    expect(result._meta).toEqual({ runId: row?.id });
  });

  it('carries a conversation on across calls that name it, as one session, and keeps calls without one apart', async () => {
    h.script = (body) => ({ content: `heard ${sentMessages(body).length}: ${lastMessage(body).content}` });
    const { base } = await h.startRouter();
    const client = await connect(base);
    await client.callTool({ name: 'helper', arguments: { message: 'one', conversation: 'chat' } });
    const second = await client.callTool({ name: 'helper', arguments: { message: 'two', conversation: 'chat' } });
    // The system prompt, the first exchange, and the new message.
    expect(textOf(second)).toBe('heard 4: two');
    const alone = await client.callTool({ name: 'helper', arguments: { message: 'three' } });
    expect(textOf(alone)).toBe('heard 2: three');
    const sessions = await h.db.select({ sessionKey: runs.sessionKey }).from(runs).orderBy(runs.startedAt);
    expect(sessions.map((row) => row.sessionKey)).toEqual(['chat', 'chat', null]);
  });

  it('refuses an agent the key may not run and a call with no message, and reports a failed run as an error', async () => {
    const { base } = await h.startRouter();
    const client = await connect(base);
    await expect(client.callTool({ name: 'nobody', arguments: { message: 'hi' } })).rejects.toThrow(
      'There is no agent named "nobody" for this key.',
    );
    await expect(client.callTool({ name: 'helper', arguments: { message: ' ' } })).rejects.toThrow('message');
    expect(await h.db.select().from(runs)).toEqual([]);

    h.script = () => ({ call: { name: 'fix_ture__fail', args: {} } });
    const failing = await client.callTool({ name: 'helper', arguments: { message: 'hi' } });
    expect(failing.isError).toBe(true);
    expect(textOf(failing)).toContain('Run ');
  });

  it('cancels the run when the client cancels the call', async () => {
    h.script = () => ({ call: { name: 'fix_ture__sleep', args: { ms: 60_000 } } });
    const { base } = await h.startRouter();
    const client = await connect(base);
    const stop = new AbortController();
    const call = client.callTool({ name: 'helper', arguments: { message: 'hi' } }, undefined, { signal: stop.signal });
    await until(() => h.received.length > 0, 'the model call');
    stop.abort();
    await expect(call).rejects.toThrow();
    const [row] = await h.db.select({ id: runs.id }).from(runs);
    const cancelled = await h.runReaches(row?.id ?? '', RunStatus.Cancelled);
    expect(cancelled.error).toBe('The app disconnected.');
    expect(await h.db.select().from(runs).where(eq(runs.status, RunStatus.Running))).toEqual([]);
  });
});

/** A JSON-RPC message from a raw request's answer. */
interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
}

/**
 * Sends one JSON-RPC request to /mcp without a client, and reads every message of its answer.
 *
 * @param base - The router.
 * @param method - The method.
 * @param params - Its params.
 * @returns The messages, notifications first and the answer last.
 */
async function rpc(base: string, method: string, params: Record<string, unknown>): Promise<RpcMessage[]> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${h.keySecret}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  const isStream = (response.headers.get('content-type') ?? '').includes('text/event-stream');
  if (isStream === false) {
    return [JSON.parse(text) as RpcMessage];
  }
  return text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as RpcMessage);
}

/**
 * Reads the task a raw task call answered with.
 *
 * @param message - The call's answer.
 * @returns The task's id.
 */
function createdTaskId(message: RpcMessage | undefined): string {
  const task = message?.result?.task;
  const taskId = isRecord(task) ? task.taskId : undefined;
  if (typeof taskId !== 'string') {
    throw new Error(`The call answered with no task: ${JSON.stringify(message)}`);
  }
  return taskId;
}

/** What a task call sends: the agent, the message, and the ask to run as a task. */
const TASK_CALL = { name: 'helper', arguments: { message: 'hello there' }, task: { ttl: 60_000 } };

describe('/mcp tasks', () => {
  it('lists each agent as able to run as a task, and says it has the tasks capability', async () => {
    const { base } = await h.startRouter();
    const client = await connect(base);
    const { tools } = await client.listTools();
    expect(tools[0]?.execution).toEqual({ taskSupport: 'optional' });
    expect(client.getServerCapabilities()?.tasks).toMatchObject({ requests: { tools: { call: {} } } });
  });

  it('answers a task call at once with the run as the task, and get and result follow the run', async () => {
    const { base } = await h.startRouter();
    const client = await connect(base);
    const created = await client.request({ method: 'tools/call', params: TASK_CALL }, CreateTaskResultSchema);
    const [row] = await h.db.select().from(runs);
    expect(created.task).toMatchObject({ taskId: row?.id, status: 'working', pollInterval: expect.any(Number) });

    const steps: string[] = [];
    const result = await client.experimental.tasks.getTaskResult(created.task.taskId, CallToolResultSchema, {
      onprogress: (progress) => steps.push(progress.message ?? ''),
    });
    expect(textOf(result)).toBe('The tool said: hello there');
    expect(steps).toContain('Calling fix_ture__echo');
    expect(await client.experimental.tasks.getTask(created.task.taskId)).toMatchObject({ status: 'completed' });
    const { tasks } = await client.experimental.tasks.listTasks();
    expect(tasks.map((task) => task.taskId)).toEqual([row?.id]);
  });

  it("sends each run event to a waiter on the task's own stream, as agent-core's RunEvent", async () => {
    const { base } = await h.startRouter();
    const [created] = await rpc(base, 'tools/call', TASK_CALL);
    const taskId = createdTaskId(created);
    const messages = await rpc(base, 'tasks/result', { taskId, _meta: { progressToken: 'p' } });
    const progress = messages.filter((message) => message.method === 'notifications/progress');
    const events = progress.map((message) => (message.params?._meta as Record<string, unknown>)?.[RUN_EVENT_META_KEY]);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call', name: ECHO, runId: taskId }));
    expect(events.at(-1)).toMatchObject({ kind: 'done', ok: true });
    expect(progress[0]?.params?._meta).toMatchObject({ [RELATED_TASK_META_KEY]: { taskId } });
    expect(messages.at(-1)?.result).toMatchObject({ _meta: { runId: taskId } });
  });

  it('keeps the run going when the connection that started it closes, and a cancel stops it', async () => {
    h.script = () => ({ call: { name: 'fix_ture__sleep', args: { ms: 60_000 } } });
    const { base } = await h.startRouter();
    // The answer to the call ends its request, and the run goes on.
    const [created] = await rpc(base, 'tools/call', TASK_CALL);
    const taskId = createdTaskId(created);
    await until(() => h.received.length > 0, 'the model call');
    const [going] = await h.db.select().from(runs).where(eq(runs.id, taskId));
    expect(going?.status).toBe(RunStatus.Running);

    const client = await connect(base);
    const cancelled = await client.experimental.tasks.cancelTask(taskId);
    expect(cancelled).toMatchObject({ taskId, status: 'cancelled' });
    expect((await h.runReaches(taskId, RunStatus.Cancelled)).error).toBe('The app cancelled the run.');
    await expect(client.experimental.tasks.cancelTask(taskId)).rejects.toThrow('has ended');
  });

  it("answers another workspace's task as missing", async () => {
    const { base } = await h.startRouter();
    const created = await (await connect(base)).request(
      { method: 'tools/call', params: TASK_CALL },
      CreateTaskResultSchema,
    );
    const other = await createWorkspaceWithKey(h.db, 'min-agent');
    await h.snapshot.rebuild();
    const stranger = await connect(base, other.secret);
    await expect(stranger.experimental.tasks.getTask(created.task.taskId)).rejects.toThrow('There is no task');
    await expect(stranger.experimental.tasks.cancelTask(created.task.taskId)).rejects.toThrow('There is no task');
    expect((await stranger.experimental.tasks.listTasks()).tasks).toEqual([]);
  });

  it('refuses a task call for an agent the key may not run, starting no run', async () => {
    const { base } = await h.startRouter();
    const client = await connect(base);
    await expect(
      client.request({ method: 'tools/call', params: { ...TASK_CALL, name: 'nobody' } }, CreateTaskResultSchema),
    ).rejects.toThrow('There is no agent named "nobody" for this key.');
    expect(await h.db.select().from(runs)).toEqual([]);
  });
});
