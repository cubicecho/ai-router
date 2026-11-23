import { ELICIT_TOOL, ElicitAction, runAgentLoop } from '@cubicecho/agent-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { INSTANCE_DEFAULTS } from '../../server/core/defaults.ts';
import { CAN_ELICIT_META_KEY } from '../../server/core/wire.ts';
import { RunStatus, runs } from '../../server/db/tables/runs.ts';
import { servers } from '../../server/db/tables/servers.ts';
import { Role } from '../../server/db/tables/users.ts';
import { createClient, createUser } from '../helpers.ts';
import {
  CREATE_AGENT,
  INSTALL,
  lastMessage,
  type Reply,
  SERVER,
  SET_SERVER_ENABLED,
  sentToolNames,
  useRunHarness,
} from './run-harness.ts';

// An MCP server asks for input during a tool call, and whoever called the agent answers it.

const h = useRunHarness();

/** The fixture's tool that asks, as the model calls it. */
const ASK = 'fix_ture__ask';
/** What the person types: it must reach the server and be stored nowhere. */
const SECRET = 'hunter2-do-not-store';
const QUESTION = { role: 'user', content: 'open it' };
const ACCEPTED = JSON.stringify({ action: 'accept', content: { code: SECRET } });

/**
 * Calls the asking tool, then says what it answered.
 *
 * @param body - A request to the fake model.
 * @returns The model's reply.
 */
const askScript = (body: Record<string, unknown>): Reply => {
  const last = lastMessage(body);
  return last.role === 'tool' ? { content: `The tool said: ${last.content}` } : { call: { name: ASK, args: {} } };
};

/**
 * Everything the router stored of the runs and their events, as text.
 *
 * @returns The rows, as JSON.
 */
async function storedText(): Promise<string> {
  const { rows } = await h.db.$client.query('SELECT row_to_json(r) AS row FROM run_events r');
  return JSON.stringify([await h.db.select().from(runs), rows]);
}

describe('a server asking for input during a run', () => {
  it("declines for a client that can't answer, and the tool carries on", async () => {
    const { base } = await h.startRouter();
    h.script = askScript;
    const response = await h.complete(base, { model: 'helper', messages: [QUESTION] });
    const answer = await response.json();
    expect(answer.choices[0].finish_reason).toBe('stop');
    expect(answer.choices[0].message.content).toBe('The tool said: decline');
  });

  it('hands the question to a /v1 app, carries the same call on with its answer, and stores none of it', async () => {
    const { base } = await h.startRouter();
    h.script = askScript;
    const body = { model: 'helper', messages: [QUESTION], agent_core: { progress: true } };
    const first = await (await h.complete(base, body)).json();
    const [call] = first.choices[0].message.tool_calls;
    expect(first.choices[0].finish_reason).toBe('tool_calls');
    expect(call.function.name).toBe(ELICIT_TOOL);
    expect(JSON.parse(call.function.arguments).message).toBe('What is the code?');
    const [waiting] = await h.db.select().from(runs);
    expect(waiting?.status).toBe(RunStatus.Waiting);

    const second = await h.complete(base, {
      ...body,
      messages: [QUESTION, first.choices[0].message, { role: 'tool', tool_call_id: call.id, content: ACCEPTED }],
    });
    const answer = await second.json();
    expect(answer.choices[0].message.content).toBe(`The tool said: got ${SECRET}`);
    // One run, and the tool was called once.
    const rows = await h.db.select().from(runs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe(RunStatus.Completed);
    const events = (await (await h.get(`${base}/runs/${rows[0]?.id}/events`)).json()).events;
    expect(events.filter((event: { kind: string; via?: unknown }) => event.kind === 'tool-call')).toHaveLength(1);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'elicit', text: 'What is the code?' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'elicit-answer', text: 'accept', fields: ['code'] }));
    expect(rows[0]?.input).not.toContainEqual(expect.objectContaining({ role: 'tool' }));
    expect(JSON.stringify(rows[0]?.resume)).not.toContain(SECRET);
  });

  it("keeps a person's answer out of the run's input and events", async () => {
    const { base } = await h.startRouter();
    // A tool's own result is recorded, so this one says only how it was answered.
    h.script = (body) => {
      const last = lastMessage(body);
      return last.role === 'tool' ? { content: 'done' } : { call: { name: ASK, args: { quiet: true } } };
    };
    const body = { model: 'helper', messages: [QUESTION], agent_core: { progress: true } };
    const first = await (await h.complete(base, body)).json();
    const [call] = first.choices[0].message.tool_calls;
    const reply = { role: 'tool', tool_call_id: call.id, content: ACCEPTED };
    await (await h.complete(base, { ...body, messages: [QUESTION, first.choices[0].message, reply] })).json();
    expect(await storedText()).not.toContain(SECRET);
  });

  it('answers through agent-core, whose onElicit the loop calls by itself', async () => {
    const { base } = await h.startRouter();
    h.script = askScript;
    const asked: string[] = [];
    const result = await runAgentLoop({
      config: {
        baseUrl: `${base}/v1`,
        apiKey: h.keySecret,
        model: 'helper',
        remoteAgent: true,
        maxToolIterations: 4,
      },
      messages: [{ role: 'user', content: 'open it' }],
      dispatch: () => Promise.reject(new Error('The agent runs its own tools.')),
      onElicit: (_server, params) => {
        asked.push(params.message);
        return { action: ElicitAction.Accept, content: { code: '42' } };
      },
    });
    expect(asked).toEqual(['What is the code?']);
    expect(result.turn.content).toContain('got 42');
  });

  it('ends a run cancelled while it waits on a question', async () => {
    const { base } = await h.startRouter();
    h.script = askScript;
    const body = { model: 'helper', messages: [QUESTION], agent_core: { progress: true } };
    await (await h.complete(base, body)).json();
    const [row] = await h.db.select().from(runs);
    const cancelled = await fetch(`${base}/runs/${row?.id}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.keySecret}` },
    });
    expect(cancelled.ok).toBe(true);
    const ended = await h.runReaches(row?.id ?? '', RunStatus.Cancelled);
    expect(ended.pendingCallIds).toEqual([]);
  });

  it('fails a run left on a question by a restart, which can never carry it on', async () => {
    const { base, runs: service } = await h.startRouter();
    h.script = askScript;
    await (await h.complete(base, { model: 'helper', messages: [QUESTION], agent_core: { progress: true } })).json();
    const [row] = await h.db.select().from(runs);
    expect(row?.status).toBe(RunStatus.Waiting);
    await service.stop();
    const [stopped] = await h.db
      .select()
      .from(runs)
      .where(eq(runs.id, row?.id ?? ''));
    expect(stopped?.status).toBe(RunStatus.Failed);
  });

  it('declines a question left unanswered, carries the run on, and refuses the late answer', async () => {
    const { base } = await h.startRouter();
    const answerWindowMs = 1_500;
    await h.db
      .update(servers)
      .set({ callTimeoutMs: INSTANCE_DEFAULTS.elicitMarginMs + answerWindowMs })
      .where(eq(servers.name, SERVER));
    await h.snapshot.rebuild();
    h.script = askScript;
    const body = { model: 'helper', messages: [QUESTION], agent_core: { progress: true } };
    const first = await (await h.complete(base, body)).json();
    const [call] = first.choices[0].message.tool_calls;
    const [row] = await h.db.select().from(runs);
    expect(row?.status).toBe(RunStatus.Waiting);

    const ended = await h.runReaches(row?.id ?? '', RunStatus.Completed);
    expect(ended.pendingCallIds).toEqual([]);
    expect(ended.answer?.content).toBe('The tool said: decline');

    const reply = { role: 'tool', tool_call_id: call.id, content: ACCEPTED };
    const late = await h.complete(base, { ...body, messages: [QUESTION, first.choices[0].message, reply] });
    expect(late.status).toBe(400);
    expect(await h.db.select().from(runs)).toHaveLength(1);
    expect(await storedText()).not.toContain(SECRET);
  });

  it.each([
    ['a plain call', false],
    ['a task', true],
  ])('puts the question to an MCP client that says it can answer, on %s', async (_what, isTask) => {
    const { base } = await h.startRouter();
    h.script = askScript;
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: { elicitation: { form: {} } } });
    const asked: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, (request) => {
      asked.push(request.params.message);
      return { action: 'accept', content: { code: '7' } };
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${h.keySecret}` } },
      }),
    );
    try {
      const params = {
        name: 'helper',
        arguments: { message: 'open it' },
        _meta: { [CAN_ELICIT_META_KEY]: true },
      };
      let text = '';
      if (isTask) {
        for await (const message of client.experimental.tasks.callToolStream(params, CallToolResultSchema)) {
          if (message.type === 'result') {
            text = JSON.stringify(message.result.content);
          }
        }
      } else {
        text = JSON.stringify((await client.callTool(params)).content);
      }
      expect(asked).toEqual(['What is the code?']);
      expect(text).toContain('got 7');
    } finally {
      await client.close();
    }
  });

  it('carries a question up through an agent calling an agent, to the app at the top', async () => {
    const { base } = await h.startRouter();
    const admin = await createUser(h.db, 'admin@example.com', Role.Admin);
    const asAdmin = createClient(h.db, admin, { snapshot: h.snapshot, tools: h.tools, models: h.models });
    await asAdmin.expectOk(INSTALL, {
      input: {
        name: 'agents',
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
    await h.offer(h.workspaceId, createAgent.id, ['agents']);
    await h.asUser.expectOk(SET_SERVER_ENABLED, {
      workspaceAgentId: h.helperEntryId,
      serverId: h.snapshot.current().servers.get('agents')?.id,
      enabled: false,
    });
    h.script = (body) => {
      const isBoss = sentToolNames(body).includes('agents__helper');
      const last = lastMessage(body);
      if (isBoss === false) {
        return askScript(body);
      }
      return last.role === 'tool'
        ? { content: `Heard: ${last.content}` }
        : { call: { name: 'agents__helper', args: { message: last.content } } };
    };
    const body = { model: 'boss', messages: [QUESTION], agent_core: { progress: true } };
    const first = await (await h.complete(base, body)).json();
    const [call] = first.choices[0].message.tool_calls;
    expect(call.function.name).toBe(ELICIT_TOOL);
    const reply = {
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify({ action: 'accept', content: { code: '9' } }),
    };
    const second = await h.complete(base, { ...body, messages: [QUESTION, first.choices[0].message, reply] });
    const answer = await second.json();
    expect(answer.choices[0].message.content).toContain('got 9');
  });
});
