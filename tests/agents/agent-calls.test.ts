import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_DEFAULTS } from '../../server/core/defaults.ts';
import { AGENT_DEPTH_META_KEY } from '../../server/core/wire.ts';
import { RunStatus, runs } from '../../server/db/tables/runs.ts';
import { servers } from '../../server/db/tables/servers.ts';
import { Role } from '../../server/db/tables/users.ts';
import { createClient, createUser } from '../helpers.ts';
import {
  CREATE_AGENT,
  ECHO_SCRIPT,
  INSTALL,
  lastMessage,
  type Reply,
  SET_SERVER_ENABLED,
  sentToolNames,
  until,
  useRunHarness,
} from './run-harness.ts';

// An agent calls another agent: a workspace adds a router's /mcp as a server, with a workspace key in its headers,
// and its agents call the agents behind it as tools. Each call runs as an MCP task, and its run is recorded on its own.

const h = useRunHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

/** The server a workspace adds for the agents behind /mcp. */
const AGENTS = 'agents';
/** The tool the `helper` agent is, through that server. */
const CALL_HELPER = 'agents__helper';
/** The tool the `boss` agent is, through that server. */
const CALL_BOSS = 'agents__boss';

/**
 * Adds the router's own /mcp as a server, with the workspace's key, and the `boss` agent, which may call it.
 *
 * @param base - The router.
 * @returns The boss agent's id.
 */
async function addAgentsServer(base: string): Promise<string> {
  const admin = await createUser(h.db, 'admin@example.com', Role.Admin);
  const asAdmin = createClient(h.db, admin, { snapshot: h.snapshot, tools: h.tools, models: h.models });
  await asAdmin.expectOk(INSTALL, {
    input: {
      name: AGENTS,
      source: { type: 'manual' },
      transport: { type: 'streamable-http', url: `${base}/mcp` },
      headers: [{ name: 'Authorization', value: `Bearer ${h.keySecret}` }],
    },
  });
  const { createAgent } = await h.asUser.expectOk(CREATE_AGENT, {
    document: {
      spec: 'cubicecho.agent/2',
      id: 'boss',
      name: 'Boss',
      description: 'Asks another agent.',
      model: { model: 'fake/m1' },
      prompt: [{ role: 'system', name: 'role', content: 'You ask the helper.' }],
      tools: { maxIterations: 6 },
    },
  });
  await h.offer(h.workspaceId, createAgent.id, [AGENTS]);
  // A server added to a workspace reaches every agent there, so the helper is kept from calling agents itself.
  const agentsId = h.snapshot.current().servers.get(AGENTS)?.id;
  await h.asUser.expectOk(SET_SERVER_ENABLED, {
    workspaceAgentId: h.helperEntryId,
    serverId: agentsId,
    enabled: false,
  });
  return createAgent.id;
}

/**
 * Answers as the agent a request is for: one that can call `tool` calls it with the user's message, then says what it
 * heard; any other is the harness's helper.
 *
 * @param tool - The agent tool the caller calls.
 * @returns The script.
 */
function callerScript(tool: string): (body: Record<string, unknown>) => Reply {
  return (body) => {
    const isCaller = sentToolNames(body).includes(tool);
    if (isCaller === false) {
      return ECHO_SCRIPT(body);
    }
    const last = lastMessage(body);
    return last.role === 'tool'
      ? { content: `Heard: ${last.content}` }
      : { call: { name: tool, args: { message: last.content } } };
  };
}

/**
 * Reads a run's stored events.
 *
 * @param base - The router.
 * @param runId - The run.
 * @returns Its events.
 */
async function eventsOf(base: string, runId: string): Promise<Record<string, unknown>[]> {
  return (await (await h.get(`${base}/runs/${runId}/events`)).json()).events;
}

describe('an agent calling an agent', () => {
  it("runs the called agent as a run of its own, with its steps and its run's link in the caller's run", async () => {
    const { base } = await h.startRouter();
    await addAgentsServer(base);
    h.script = callerScript(CALL_HELPER);
    const requests = vi.spyOn(Client.prototype, 'request');
    const response = await h.complete(base, { model: 'boss', messages: [{ role: 'user', content: 'hello there' }] });
    const answer = await response.json();
    expect(answer.choices[0].message.content).toBe('Heard: The tool said: hello there');
    // As a task: the call is answered at once, and the router waits on the task's result.
    const methods = requests.mock.calls.map(([request]) => request.method);
    expect(methods).toEqual(expect.arrayContaining(['tools/call', 'tasks/result']));
    expect(requests.mock.calls.find(([request]) => request.method === 'tools/call')?.[2]).toMatchObject({ task: {} });

    const rows = await h.db.select().from(runs).orderBy(asc(runs.startedAt));
    expect(rows.map((row) => [row.agentName, row.status])).toEqual([
      ['boss', RunStatus.Completed],
      ['helper', RunStatus.Completed],
    ]);
    const [boss, helper] = rows;
    const events = await eventsOf(base, boss?.id ?? '');
    const notices = events.filter((event) => event.kind === 'notice');
    // The called run's own events, filed under the call that ran it, its `done` included.
    const callId = events.find((event) => event.kind === 'tool-call' && event.via === undefined)?.id;
    const hop = [{ runId: helper?.id, callId }];
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call', name: 'fix_ture__echo', via: hop }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'done', ok: true, via: hop }));
    // Its `done` didn't end the caller's: the caller's own comes last.
    expect(events.at(-1)).toMatchObject({ kind: 'done', ok: true });
    expect(events.at(-1)?.via).toBeUndefined();
    expect(notices).toContainEqual(
      expect.objectContaining({ name: CALL_HELPER, link: { name: helper?.id, uri: `/runs/${helper?.id}` } }),
    );
  });

  it('checks a quiet task once a call timeout passes without a word, and waits on for its result', {
    timeout: 30_000,
  }, async () => {
    const { base } = await h.startRouter();
    await addAgentsServer(base);
    // The helper's sleep sends no progress, so the wait on its result goes quiet for longer than this. It is also how
    // long starting the task may take, so it leaves room for a busy machine.
    const quietMs = 1_500;
    await h.db.update(servers).set({ callTimeoutMs: quietMs }).where(eq(servers.name, AGENTS));
    await h.snapshot.rebuild();
    const calls = callerScript(CALL_HELPER);
    h.script = (body) => {
      const isHelper = sentToolNames(body).includes(CALL_HELPER) === false;
      const isFirstTurn = lastMessage(body).role === 'user';
      return isHelper && isFirstTurn ? { call: { name: 'fix_ture__sleep', args: { ms: quietMs * 3 } } } : calls(body);
    };
    const requests = vi.spyOn(Client.prototype, 'request');
    const response = await h.complete(base, { model: 'boss', messages: [{ role: 'user', content: 'take your time' }] });
    const answer = await response.json();
    expect(answer.choices[0].message.content).toMatch(/^Heard: /);
    const methods = requests.mock.calls.map(([request]) => request.method);
    expect(methods).toEqual(expect.arrayContaining(['tasks/get']));
    expect(methods.filter((method) => method === 'tasks/result').length).toBeGreaterThan(1);
    // Asking again starts from the called run's first event, and none of them is filed twice.
    const [boss] = await h.db.select().from(runs).where(eq(runs.agentName, 'boss'));
    const nested = (await eventsOf(base, boss?.id ?? '')).filter((event) => event.via !== undefined);
    const toolCalls = nested.filter((event) => event.kind === 'tool-call');
    expect(toolCalls).toHaveLength(1);
  });

  it("keeps a called agent's work out of a plain client's reasoning and answer", async () => {
    const { base } = await h.startRouter();
    await addAgentsServer(base);
    h.script = callerScript(CALL_HELPER);
    const response = await h.complete(base, {
      model: 'boss',
      stream: true,
      messages: [{ role: 'user', content: 'hello there' }],
    });
    const body = await response.text();
    expect(body).toContain(CALL_HELPER);
    expect(body).not.toContain('fix_ture__echo');
  });

  it(`refuses a call more than ${RUN_DEFAULTS.maxAgentDepth} agents deep, so an agent calling itself stops`, async () => {
    const { base } = await h.startRouter();
    await addAgentsServer(base);
    h.script = callerScript(CALL_BOSS);
    const response = await h.complete(base, { model: 'boss', messages: [{ role: 'user', content: 'again' }] });
    const answer = await response.json();
    expect(answer.choices[0].message.content).toContain(`Agents may call agents ${RUN_DEFAULTS.maxAgentDepth} deep`);
    const rows = await h.db.select().from(runs);
    // The app's run and one per level below it.
    expect(rows).toHaveLength(RUN_DEFAULTS.maxAgentDepth + 1);
    expect(rows.every((row) => row.status === RunStatus.Completed)).toBe(true);
  });

  it('refuses a call that says it is past the limit, from any client', async () => {
    const { base } = await h.startRouter();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${h.keySecret}` } },
      }),
    );
    try {
      const result = await client.callTool({
        name: 'helper',
        arguments: { message: 'hi' },
        _meta: { [AGENT_DEPTH_META_KEY]: RUN_DEFAULTS.maxAgentDepth + 1 },
      });
      expect(result.isError).toBe(true);
      expect(await h.db.select().from(runs)).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("cancels the called agent's run when the caller's run is cancelled", async () => {
    const { base } = await h.startRouter();
    await addAgentsServer(base);
    const calls = callerScript(CALL_HELPER);
    h.script = (body) =>
      sentToolNames(body).includes(CALL_HELPER)
        ? calls(body)
        : { call: { name: 'fix_ture__sleep', args: { ms: 60_000 } } };
    void h.complete(
      base,
      { model: 'boss', messages: [{ role: 'user', content: 'wait' }] },
      { 'idempotency-key': 'k1' },
    );
    let helperId = '';
    await until(async () => {
      const [helper] = await h.db.select().from(runs).where(eq(runs.agentName, 'helper'));
      helperId = helper?.id ?? '';
      return helperId !== '';
    }, "the helper's run");
    const [boss] = await h.db.select().from(runs).where(eq(runs.agentName, 'boss'));
    const cancelled = await fetch(`${base}/runs/${boss?.id}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.keySecret}` },
    });
    expect(cancelled.ok).toBe(true);
    await h.runReaches(boss?.id ?? '', RunStatus.Cancelled);
    await h.runReaches(helperId, RunStatus.Cancelled);
  });
});
