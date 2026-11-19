import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { createRunService } from '../../server/agents/run.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { activity } from '../../server/db/tables/activity.ts';
import { agents } from '../../server/db/tables/agents.ts';
import { RunStatus, runs } from '../../server/db/tables/runs.ts';
import { usageCounts } from '../../server/db/tables/usage-counts.ts';
import { createSessionToken, createTestAuth, createWorkspaceWithKey } from '../helpers.ts';
import {
  AGENT_PROMPT,
  CREATE_AGENT,
  CREATE_ENTRY,
  dataLines,
  ECHO,
  FIXTURE,
  GRANT,
  INSTALL,
  lastMessage,
  QUESTION,
  SERVER,
  useRunHarness,
} from './run-harness.ts';

// A workspace key runs an agent end to end: the router's /v1, a fake provider reached through the models area's
// own fetch, and the stdio fixture as the agent's MCP server.

const h = useRunHarness();

describe('the agents endpoint', () => {
  it('lists the agents this key may run, marked as agents', async () => {
    const { base } = await h.startRouter();
    await h.asUser.expectOk(CREATE_AGENT, {
      document: { spec: 'cubicecho.agent/1', id: 'not-granted', model: { model: 'fake/m1' }, tools: { servers: [] } },
    });
    const response = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${h.keySecret}` } });
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
    const one = await fetch(`${base}/v1/models/helper`, { headers: { 'x-api-key': h.keySecret } });
    expect(await one.json()).toMatchObject({ id: 'helper' });
    const hidden = await fetch(`${base}/v1/models/not-granted`, { headers: { 'x-api-key': h.keySecret } });
    expect(hidden.status).toBe(HttpStatus.NotFound);
  });

  it('answers one agent with its list entry, and the same model_not_found for any agent the key may not run', async () => {
    const { base } = await h.startRouter();
    const headers = { authorization: `Bearer ${h.keySecret}` };
    const list = await (await fetch(`${base}/v1/models`, { headers })).json();
    const one = await fetch(`${base}/v1/models/helper`, { headers });
    expect(one.status).toBe(HttpStatus.Ok);
    expect(await one.json()).toEqual(list.data[0]);

    await h.asUser.expectOk(CREATE_AGENT, {
      document: { spec: 'cubicecho.agent/1', id: 'ungranted', model: { model: 'fake/m1' }, tools: { servers: [] } },
    });
    const { createAgent } = await h.asUser.expectOk(CREATE_AGENT, {
      document: { spec: 'cubicecho.agent/1', id: 'unpromoted', model: { model: 'fake/m1' }, tools: { servers: [] } },
    });
    await h.asUser.expectOk(GRANT, { v: { workspaceId: h.workspaceId, agentId: createAgent.id } });
    await h.db.update(agents).set({ liveRevisionId: null }).where(eq(agents.id, createAgent.id));
    await h.snapshot.rebuild();

    const missing = async (name: string) => {
      const response = await fetch(`${base}/v1/models/${name}`, { headers });
      expect(response.status).toBe(HttpStatus.NotFound);
      const { error } = await response.json();
      return { ...error, message: error.message.replace(name, '<name>') };
    };
    const unknown = await missing('nobody');
    expect(unknown).toMatchObject({ code: 'model_not_found', type: 'invalid_request_error', param: 'model' });
    expect(await missing('ungranted')).toEqual(unknown);
    expect(await missing('unpromoted')).toEqual(unknown);
    expect((await fetch(`${base}/v1/models/helper`)).status).toBe(HttpStatus.Unauthorized);
  });

  it('takes workspace keys only: no key, a session, or two different keys are refused', async () => {
    const { base } = await h.startRouter();
    const none = await fetch(`${base}/v1/models`);
    expect(none.status).toBe(HttpStatus.Unauthorized);
    expect(await none.json()).toMatchObject({ error: { code: 'invalid_api_key', type: 'invalid_request_error' } });
    const session = await createSessionToken(createTestAuth(h.db), h.user.userId);
    const asPerson = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${session}` } });
    expect(asPerson.status).toBe(HttpStatus.Unauthorized);
    vi.stubEnv('SECURE_LOCAL_NET', 'true');
    try {
      expect((await fetch(`${base}/v1/models`)).status).toBe(HttpStatus.Unauthorized);
    } finally {
      vi.unstubAllEnvs();
    }
    const both = await fetch(`${base}/v1/models`, {
      headers: { authorization: `Bearer ${h.keySecret}`, 'x-api-key': 'air_other' },
    });
    expect(both.status).toBe(HttpStatus.BadRequest);
  });

  it('answers 404 in the OpenAI envelope for other paths, and the same 404 for an unknown or ungranted agent', async () => {
    const { base } = await h.startRouter();
    const other = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.keySecret}` },
    });
    expect(other.status).toBe(HttpStatus.NotFound);
    expect(await other.json()).toMatchObject({ error: { code: 'not_found' } });
    await h.asUser.expectOk(CREATE_AGENT, {
      document: { spec: 'cubicecho.agent/1', id: 'private', model: { model: 'fake/m1' }, tools: { servers: [] } },
    });
    const unknown = await h.complete(base, { model: 'nobody', messages: [QUESTION] });
    const ungranted = await h.complete(base, { model: 'private', messages: [QUESTION] });
    expect(unknown.status).toBe(HttpStatus.NotFound);
    expect(ungranted.status).toBe(HttpStatus.NotFound);
    const [a, b] = [await unknown.json(), await ungranted.json()];
    expect(a.error.code).toBe('model_not_found');
    expect(b.error).toEqual({ ...a.error, message: a.error.message.replace('nobody', 'private') });
    expect(unknown.headers.get('x-run-id')).toBeNull();
    expect(await h.db.select().from(runs)).toEqual([]);
  });

  it('runs the agent: its model calls an MCP tool from the stub server, and the run answers and is recorded', async () => {
    const { base } = await h.startRouter();
    const response = await h.complete(base, {
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
    const [first] = h.received;
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

    const [row] = await h.db.select().from(runs);
    expect(row).toMatchObject({
      id: runId,
      workspaceId: h.workspaceId,
      workspaceName: 'task-server',
      agentId: h.agentId,
      agentName: 'helper',
      revisionId: h.revisionId,
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
    await h.models.usage.flush();
    expect(await h.db.select().from(usageCounts)).toEqual([
      expect.objectContaining({
        workspaceId: h.workspaceId,
        workspaceName: 'task-server',
        agentId: h.agentId,
        agentName: 'helper',
        model: 'm1',
        requests: 2,
      }),
    ]);
    await h.tools.activity.flush();
    expect(await h.db.select().from(activity)).toEqual([
      expect.objectContaining({
        serverName: SERVER,
        tool: 'echo',
        ok: true,
        runId,
        agentId: h.agentId,
        agentName: 'helper',
        workspaceId: h.workspaceId,
      }),
    ]);
  });

  it('streams the answer as chunks, with the usage chunk when asked', async () => {
    const { base } = await h.startRouter();
    const response = await h.complete(base, {
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
    const plain = await dataLines(await h.complete(base, { model: 'helper', messages: [QUESTION], stream: true }));
    expect(plain.some((line) => typeof line === 'object' && line !== null && 'usage' in line)).toBe(false);
  });

  it('refuses what the override policy refuses, before any run is recorded', async () => {
    const { base } = await h.startRouter();
    const cases: [Record<string, unknown>, string][] = [
      [{ logit_bias: { 50256: -100 } }, 'logit_bias'],
      [{ logprobs: true }, 'logprobs'],
      [{ n: 2 }, 'n'],
      [{ tool_choice: 'required' }, 'tool_choice'],
      [{ tools: [{ type: 'function', function: { name: 'ask user' } }] }, 'tools'],
      [{ tools: [{ type: 'function', function: { name: 'load_tools' } }] }, 'tools.0'],
    ];
    for (const [extra, param] of cases) {
      const response = await h.complete(base, { model: 'helper', messages: [QUESTION], ...extra });
      expect(response.status).toBe(HttpStatus.BadRequest);
      const { error } = await response.json();
      expect(error).toMatchObject({ type: 'invalid_request_error', param });
      expect(error.message).toContain(param);
    }
    expect(await h.db.select().from(runs)).toEqual([]);
    expect(h.received).toEqual([]);
  });

  it('runs a workspace instance with its own settings when the workspace has an entry for the server', async () => {
    const { server } = await h.asUser.expectOk(
      'query ($name: String!) { server(where: { name: { eq: $name } }) { id } }',
      {
        name: SERVER,
      },
    );
    await h.asUser.expectOk(CREATE_ENTRY, {
      values: { workspaceId: h.workspaceId, serverId: server.id, env: { FIXTURE_GREETING: 'household a' } },
    });
    h.script = (body) => {
      const last = lastMessage(body);
      return last.role === 'tool' ? { content: last.content } : { call: { name: 'fix_ture__env', args: {} } };
    };
    const { base } = await h.startRouter();
    const answer = await (await h.complete(base, { model: 'helper', messages: [QUESTION] })).json();
    expect(JSON.parse(answer.choices[0].message.content).FIXTURE_GREETING).toBe('household a');
  });

  it('leaves out a server that fails to start, and says so, without failing the run', async () => {
    await h.asUser.expectOk(INSTALL, {
      input: {
        name: 'broken',
        source: { type: 'manual' },
        transport: { type: 'stdio', command: process.execPath, args: [FIXTURE, '--die-at-start'] },
      },
    });
    const { createAgent } = await h.asUser.expectOk(CREATE_AGENT, {
      document: { spec: 'cubicecho.agent/1', id: 'everything', model: { model: 'fake/m1' } },
    });
    await h.asUser.expectOk(GRANT, { v: { workspaceId: h.workspaceId, agentId: createAgent.id } });
    const { base, runs: runService } = await h.startRouter();
    const response = await h.complete(base, { model: 'everything', messages: [QUESTION] });
    expect(response.status).toBe(HttpStatus.Ok);
    const names = (Array.isArray(h.received[0]?.tools) ? h.received[0].tools : []).map((tool) => tool.function.name);
    expect(names).toContain(ECHO);
    expect(names.some((name: string) => name.startsWith('broken__'))).toBe(false);
    const events = await runService.bus.events(response.headers.get('x-run-id') ?? '');
    expect(events.some((event) => event.kind === 'notice' && event.text.includes('"broken"'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ kind: 'done', ok: true });
  });
});

describe('Idempotency-Key', () => {
  it('replays a finished run instead of starting another, streamed or not as asked', async () => {
    const { base } = await h.startRouter();
    const body = { model: 'helper', messages: [QUESTION] };
    const first = await h.complete(base, body, { 'idempotency-key': 'friday-1' });
    const runId = first.headers.get('x-run-id');
    const firstAnswer = await first.json();
    const again = await h.complete(base, body, { 'idempotency-key': 'friday-1' });
    expect(again.headers.get('x-run-id')).toBe(runId);
    expect(await again.json()).toEqual(firstAnswer);
    const streamed = await h.complete(base, { ...body, stream: true }, { 'idempotency-key': 'friday-1' });
    expect(streamed.headers.get('x-run-id')).toBe(runId);
    const lines = await dataLines(streamed);
    const text = (lines.slice(0, -1) as { choices: { delta: { content?: string } }[] }[])
      .flatMap((chunk) => chunk.choices.map((choice) => choice.delta.content ?? ''))
      .join('');
    expect(text).toBe('The tool said: hello there');
    expect(await h.db.select({ id: runs.id }).from(runs)).toEqual([{ id: runId }]);
    expect(h.received).toHaveLength(2);
  });

  it('answers 422 for the same key with a different body', async () => {
    const { base } = await h.startRouter();
    await (await h.complete(base, { model: 'helper', messages: [QUESTION] }, { 'idempotency-key': 'k' })).json();
    const changed = await h.complete(
      base,
      { model: 'helper', messages: [{ role: 'user', content: 'other' }] },
      { 'idempotency-key': 'k' },
    );
    expect(changed.status).toBe(HttpStatus.UnprocessableEntity);
    expect(await changed.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } });
    expect(changed.headers.get('x-run-id')).not.toBeNull();
  });

  it('waits for a run still going with that key, then replays it', async () => {
    h.script = (body) => {
      const last = lastMessage(body);
      return last.role === 'tool'
        ? { content: 'slept well' }
        : { call: { name: 'fix_ture__sleep', args: { ms: 400 } } };
    };
    const { base } = await h.startRouter();
    const body = { model: 'helper', messages: [QUESTION] };
    const [one, two] = await Promise.all([
      h.complete(base, body, { 'idempotency-key': 'once' }),
      new Promise((resolve) => setTimeout(resolve, 100)).then(() =>
        h.complete(base, body, { 'idempotency-key': 'once' }),
      ),
    ]);
    expect(two.headers.get('x-run-id')).toBe(one.headers.get('x-run-id'));
    expect((await two.json()).choices[0].message.content).toBe('slept well');
    expect((await one.json()).choices[0].message.content).toBe('slept well');
    expect(await h.db.select({ id: runs.id }).from(runs)).toHaveLength(1);
  });

  it('keeps keys apart per workspace', async () => {
    const other = await createWorkspaceWithKey(h.db, 'min-agent');
    await h.asUser.expectOk(GRANT, { v: { workspaceId: other.workspaceId, agentId: h.agentId } });
    const { base } = await h.startRouter();
    const body = { model: 'helper', messages: [QUESTION] };
    const mine = await h.complete(base, body, { 'idempotency-key': 'same' });
    const theirs = await h.complete(base, body, { 'idempotency-key': 'same', authorization: `Bearer ${other.secret}` });
    expect(theirs.headers.get('x-run-id')).not.toBe(mine.headers.get('x-run-id'));
  });
});

describe("a run's end", () => {
  it('is cancelled when the app disconnects', async () => {
    h.script = () => ({ call: { name: 'fix_ture__sleep', args: { ms: 5_000 } } });
    const { base } = await h.startRouter();
    const response = await h.complete(base, { model: 'helper', messages: [QUESTION], stream: true }, {});
    const runId = response.headers.get('x-run-id') ?? '';
    // Wait for the tool call, then hang up.
    while (h.received.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await response.body?.cancel();
    const row = await h.runReaches(runId, RunStatus.Cancelled);
    expect(row.error).toBe('The app disconnected.');
  });

  it('goes on when the app disconnects from a run with an Idempotency-Key, so its retry gets the answer', async () => {
    h.script = () => ({ call: { name: 'fix_ture__sleep', args: { ms: 300 } } });
    const { base } = await h.startRouter();
    const body = { model: 'helper', messages: [QUESTION], stream: true };
    const response = await h.complete(base, body, { 'idempotency-key': 'dropped' });
    const runId = response.headers.get('x-run-id') ?? '';
    while (h.received.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await response.body?.cancel();
    h.script = () => ({ content: 'Done.' });
    await h.runReaches(runId, RunStatus.Completed);
    const retry = await h.complete(base, { ...body, stream: false }, { 'idempotency-key': 'dropped' });
    expect(retry.headers.get('x-run-id')).toBe(runId);
    expect(retry.status).toBe(HttpStatus.Ok);
    expect((await retry.json()).choices[0].message.content).toBe('Done.');
  });

  it('fails at the run timeout', async () => {
    h.script = () => ({ call: { name: 'fix_ture__sleep', args: { ms: 5_000 } } });
    const { base } = await h.startRouter({ timeoutMinutes: 0.005 });
    const response = await h.complete(base, { model: 'helper', messages: [QUESTION] });
    expect(response.status).toBe(HttpStatus.InternalServerError);
    expect(await response.json()).toMatchObject({ error: { code: 'run_failed' } });
    const [row] = await h.db.select().from(runs);
    expect(row).toMatchObject({ status: RunStatus.Failed, error: 'The run took longer than 0.005 minutes.' });
    const streamed = await dataLines(await h.complete(base, { model: 'helper', messages: [QUESTION], stream: true }));
    expect(streamed.at(-1)).toMatchObject({ error: { code: 'run_failed' } });
  });

  it('fails a run left running by a restart, and prunes old runs and spent keys', async () => {
    const values = {
      workspaceId: h.workspaceId,
      workspaceName: 'task-server',
      agentId: h.agentId,
      agentName: 'helper',
      stream: false,
    };
    const [left] = await h.db
      .insert(runs)
      .values({ ...values, status: RunStatus.Running })
      .returning();
    const long = new Date(Date.now() - 40 * 86_400_000);
    const yesterday = new Date(Date.now() - 2 * 86_400_000);
    await h.db.insert(runs).values({ ...values, status: RunStatus.Completed, startedAt: long, finishedAt: long });
    const [recent] = await h.db
      .insert(runs)
      .values({
        ...values,
        status: RunStatus.Completed,
        idempotencyKey: 'old',
        requestHash: 'h',
        finishedAt: yesterday,
      })
      .returning();
    const runService = createRunService({ db: h.db, snapshot: h.snapshot, tools: h.tools });
    expect(await runService.recover()).toBe(1);
    const [recovered] = await h.db
      .select()
      .from(runs)
      .where(eq(runs.id, left?.id ?? ''));
    expect(recovered).toMatchObject({
      status: RunStatus.Failed,
      error: 'The router restarted while the run was going.',
    });
    await runService.prune();
    const kept = await h.db.select().from(runs);
    expect(kept.map((row) => row.id).sort()).toEqual([left?.id, recent?.id].sort());
    expect(kept.find((row) => row.id === recent?.id)).toMatchObject({ idempotencyKey: null, requestHash: null });
  });
});

describe('the runEvents subscription', () => {
  it("streams a run's events to a person, and refuses a key", async () => {
    const { base } = await h.startRouter();
    const response = await h.complete(base, { model: 'helper', messages: [QUESTION] });
    const runId = response.headers.get('x-run-id');
    await response.json();
    const session = await createSessionToken(createTestAuth(h.db), h.user.userId);
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
    const refused = await (await subscribe(h.keySecret)).text();
    expect(refused).toContain('FORBIDDEN');
  });
});
