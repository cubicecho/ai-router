import type { RunEvent } from '@cubicecho/agent-core';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { HttpStatus } from '../../server/core/wire.ts';
import { RunStatus, runs } from '../../server/db/tables/runs.ts';
import { Role } from '../../server/db/tables/users.ts';
import { createClient, createUser } from '../helpers.ts';
import {
  dataLines,
  ECHO,
  lastMessage,
  QUESTION,
  type Reply,
  sentMessages,
  sentToolNames,
  useRunHarness,
} from './run-harness.ts';

// An app's own tools: the run hands the model's call back as an ordinary OpenAI answer, waits, and carries on as the
// same run when the app sends the conversation back with the call answered.

const h = useRunHarness();

/** The app's tool, as an OpenAI client sends it. */
const ASK_USER = {
  type: 'function',
  function: {
    name: 'ask_user',
    description: 'Asks the person a question.',
    parameters: { type: 'object', properties: { question: { type: 'string' } } },
  },
};
/** Sets the router's app-tool cap. */
const SET_CAP =
  'mutation ($input: RouterSettingsInput!) { updateRouterSettings(input: $input) { maxAppTools { value } } }';
/** A second app tool. */
const PICK_DATE = { type: 'function', function: { name: 'pick_date', parameters: { type: 'object' } } };

/** Asks the user, then answers with what the app said. */
const ASK_SCRIPT = (body: Record<string, unknown>): Reply => {
  const last = lastMessage(body);
  return last.role === 'tool'
    ? { content: `The app said: ${last.content}` }
    : { call: { name: 'ask_user', args: { question: 'Which colour?' } } };
};

/** A handed-back call, as the answer carries it. */
interface Call {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

/**
 * Starts a run that hands `ask_user` back.
 *
 * @param base - The router.
 * @param [extra] - More of the request.
 * @param [headers] - More headers.
 * @returns The run, its answer's message and its calls.
 */
async function handBack(base: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const response = await h.complete(
    base,
    { model: 'helper', messages: [QUESTION], tools: [ASK_USER], ...extra },
    headers,
  );
  expect(response.status).toBe(HttpStatus.Ok);
  const runId = response.headers.get('x-run-id') ?? '';
  const answer = await response.json();
  const [choice] = answer.choices;
  const calls: Call[] = choice.message.tool_calls;
  return { runId, answer, message: choice.message, calls };
}

/**
 * Builds the request that answers the handed-back calls, as an OpenAI client's tool loop sends it.
 *
 * @param message - The answer's message.
 * @param answers - What the app says for each call, by id.
 * @param [extra] - More of the request.
 * @returns The body.
 */
function answering(message: unknown, answers: Record<string, string>, extra: Record<string, unknown> = {}) {
  const results = Object.entries(answers).map(([id, content]) => ({ role: 'tool', tool_call_id: id, content }));
  return { model: 'helper', messages: [QUESTION, message, ...results], tools: [ASK_USER], ...extra };
}

/**
 * Reads a run's stored events.
 *
 * @param base - The router.
 * @param runId - The run.
 * @returns The events.
 */
async function eventsOf(base: string, runId: string): Promise<RunEvent[]> {
  return (await (await h.get(`${base}/runs/${runId}/events`)).json()).events;
}

describe('app tools', () => {
  it('hands the call back as tool_calls, waits, and carries on as the same run when the app answers', async () => {
    h.script = ASK_SCRIPT;
    const { base } = await h.startRouter();
    const { runId, answer, message, calls } = await handBack(base);
    expect(answer.choices[0].finish_reason).toBe('tool_calls');
    expect(message).toMatchObject({ role: 'assistant', content: null });
    expect(calls).toEqual([
      {
        id: expect.stringMatching(/^[A-Za-z0-9]{9}$/),
        type: 'function',
        function: { name: 'ask_user', arguments: JSON.stringify({ question: 'Which colour?' }) },
      },
    ]);
    // The router minted the id: the model's own was call_1.
    const [call] = calls;
    expect(call?.id).not.toBe('call_1');
    expect(sentToolNames(h.received[0])).toEqual(expect.arrayContaining([ECHO, 'ask_user']));
    const waiting = await (await h.get(`${base}/runs/${runId}`)).json();
    expect(waiting).toMatchObject({ status: RunStatus.Waiting, finishedAt: null, waitingSince: expect.any(String) });
    expect(waiting.usage.inputTokens).toBe(10);

    const resumed = await h.complete(base, answering(message, { [call?.id ?? '']: 'blue' }));
    expect(resumed.status).toBe(HttpStatus.Ok);
    expect(resumed.headers.get('x-run-id')).toBe(runId);
    const done = await resumed.json();
    expect(done.choices[0]).toMatchObject({
      message: { role: 'assistant', content: 'The app said: blue' },
      finish_reason: 'stop',
    });
    expect(done.usage).toEqual({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
    // The model read the app's answer under the id the app answered.
    const sent = sentMessages(h.received[1]);
    expect(sent.at(-2)?.tool_calls?.[0]?.id).toBe(call?.id);
    expect(sent.at(-1)).toEqual({ role: 'tool', tool_call_id: call?.id, content: 'blue' });
    expect(await h.db.select({ id: runs.id }).from(runs)).toEqual([{ id: runId }]);
    const [row] = await h.db.select().from(runs);
    expect(row).toMatchObject({ status: RunStatus.Completed, resume: null, pendingCallIds: [] });

    // The app's call is in the timeline like any other, under the id it was handed back with.
    const events = await eventsOf(base, runId);
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index + 1));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call', name: 'ask_user', id: call?.id }));
    const results = events.filter((event) => event.kind === 'tool-result' && event.name === 'ask_user');
    expect(results).toEqual([expect.objectContaining({ id: call?.id, ok: true, text: 'blue' })]);
    expect(events.filter((event) => event.kind === 'done')).toEqual([expect.objectContaining({ ok: true })]);
  });

  it('streams the hand-back as tool call chunks, ending with finish_reason tool_calls', async () => {
    h.script = ASK_SCRIPT;
    const { base } = await h.startRouter();
    const response = await h.complete(base, { model: 'helper', messages: [QUESTION], tools: [ASK_USER], stream: true });
    const lines = await dataLines(response);
    expect(lines.at(-1)).toBe('[DONE]');
    const chunks = lines.slice(0, -1) as {
      choices: { delta: { tool_calls?: Call[] }; finish_reason: string | null }[];
    }[];
    const calls = chunks.flatMap((chunk) => chunk.choices.flatMap((choice) => choice.delta.tool_calls ?? []));
    expect(calls).toEqual([
      expect.objectContaining({ index: 0, type: 'function', function: expect.objectContaining({ name: 'ask_user' }) }),
    ]);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('tool_calls');
  });

  it("runs the agent's own tools in the same step, and hands back only the app's", async () => {
    h.script = (body) =>
      lastMessage(body).role === 'tool'
        ? { content: 'Both done.' }
        : {
            calls: [
              { name: ECHO, args: { text: 'from the router' } },
              { name: 'ask_user', args: { question: 'Sure?' } },
            ],
          };
    const { base } = await h.startRouter();
    const { runId, message, calls } = await handBack(base);
    expect(calls.map((call) => call.function.name)).toEqual(['ask_user']);
    const [call] = calls;
    const done = await (await h.complete(base, answering(message, { [call?.id ?? '']: 'yes' }))).json();
    expect(done.choices[0].message.content).toBe('Both done.');
    const sent = sentMessages(h.received[1]).filter((sentMessage) => sentMessage.role === 'tool');
    expect(sent.map((result) => result.content)).toEqual(['from the router', 'yes']);
    const events = await eventsOf(base, runId);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-result', name: ECHO, ok: true }));
  });

  it('refuses a partial answer, and carries on once every call is answered', async () => {
    h.script = (body) =>
      lastMessage(body).role === 'tool'
        ? { content: 'Thanks.' }
        : {
            calls: [
              { name: 'ask_user', args: { question: 'Name?' } },
              { name: 'pick_date', args: {} },
            ],
          };
    const { base } = await h.startRouter();
    const { runId, message, calls } = await handBack(base, { tools: [ASK_USER, PICK_DATE] });
    expect(calls).toHaveLength(2);
    const [first, second] = calls;
    const partial = await h.complete(
      base,
      answering(message, { [first?.id ?? '']: 'Ada' }, { tools: [ASK_USER, PICK_DATE] }),
    );
    expect(partial.status).toBe(HttpStatus.BadRequest);
    const { error } = await partial.json();
    expect(error).toMatchObject({ param: 'messages', code: 'invalid_request' });
    expect(error.message).toContain(second?.id);
    expect((await h.db.select().from(runs))[0]?.status).toBe(RunStatus.Waiting);
    const whole = await h.complete(
      base,
      answering(message, { [first?.id ?? '']: 'Ada', [second?.id ?? '']: 'Friday' }, { tools: [ASK_USER, PICK_DATE] }),
    );
    expect(whole.headers.get('x-run-id')).toBe(runId);
    expect((await whole.json()).choices[0].message.content).toBe('Thanks.');
  });

  it("refuses a resume whose host or task text differs from the run's, and keeps the run's own", async () => {
    h.script = ASK_SCRIPT;
    const { base } = await h.startRouter();
    const host = { role: 'system', content: 'You are in min-agent.' };
    const extra = { ai_router: { task: 'Ask about colours.' } };
    const response = await h.complete(base, {
      model: 'helper',
      messages: [host, QUESTION],
      tools: [ASK_USER],
      ...extra,
    });
    const answer = await response.json();
    const { message } = answer.choices[0];
    const answers = { [message.tool_calls[0].id]: 'green' };
    const resumeWith = (lead: unknown[], options: Record<string, unknown>) => {
      const body = answering(message, answers, options);
      return h.complete(base, { ...body, messages: [...lead, ...body.messages] });
    };
    const otherHost = await resumeWith([{ role: 'system', content: 'You are somewhere else.' }], extra);
    expect(otherHost.status).toBe(HttpStatus.BadRequest);
    expect((await otherHost.json()).error.param).toBe('messages');
    const otherTask = await resumeWith([host], { ai_router: { task: 'Something else.' } });
    expect(otherTask.status).toBe(HttpStatus.BadRequest);
    expect((await otherTask.json()).error.param).toBe('ai_router.task');
    // Leaving both out keeps the run's own.
    const kept = await resumeWith([], {});
    expect(kept.status).toBe(HttpStatus.Ok);
    expect(sentMessages(h.received[1])[0]?.content).toContain('You are in min-agent.\n\nAsk about colours.');
  });

  it('refuses tool messages that answer no waiting run, and an answer that comes after the run expired', async () => {
    h.script = ASK_SCRIPT;
    const { base, runs: runService } = await h.startRouter();
    const stray = await h.complete(
      base,
      answering(
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'nobodys', type: 'function', function: { name: 'ask_user', arguments: '{}' } }],
        },
        { nobodys: 'x' },
      ),
    );
    expect(stray.status).toBe(HttpStatus.BadRequest);
    expect((await stray.json()).error.param).toBe('messages');

    const { runId, message, calls } = await handBack(base);
    const long = new Date(Date.now() - 2 * 86_400_000);
    await h.db.update(runs).set({ waitingSince: long }).where(eq(runs.id, runId));
    const late = await h.complete(base, answering(message, { [calls[0]?.id ?? '']: 'blue' }));
    expect(late.status).toBe(HttpStatus.Conflict);
    expect((await late.json()).error.code).toBe('run_expired');
    const [row] = await h.db.select().from(runs);
    expect(row).toMatchObject({ status: RunStatus.Expired, resume: null });
    expect(row?.error).toContain('24 hours');
    expect((await eventsOf(base, runId)).at(-1)).toMatchObject({ kind: 'done', ok: false });

    // The timer expires the others.
    const second = await handBack(base);
    await h.db.update(runs).set({ waitingSince: long }).where(eq(runs.id, second.runId));
    await runService.expire();
    expect(await h.runReaches(second.runId, RunStatus.Expired)).toMatchObject({ resume: null });
  });

  it('refuses an app tool with the name of one of the agent’s own tools, before any run is recorded', async () => {
    const { base } = await h.startRouter();
    const response = await h.complete(base, {
      model: 'helper',
      messages: [QUESTION],
      tools: [{ type: 'function', function: { name: ECHO } }],
    });
    expect(response.status).toBe(HttpStatus.BadRequest);
    const { error } = await response.json();
    expect(error.param).toBe('tools.0');
    expect(error.message).toContain('"echo" of server "fix.ture"');
    expect(await h.db.select().from(runs)).toEqual([]);
  });

  it("refuses more tools than the router's settings allow, as soon as an admin lowers the cap", async () => {
    const admin = await createUser(h.db, 'admin@example.com', Role.Admin);
    const asAdmin = createClient(h.db, admin, { snapshot: h.snapshot, tools: h.tools, models: h.models });
    const { base } = await h.startRouter();
    await asAdmin.expectOk(SET_CAP, { input: { maxAppTools: 1 } });
    const response = await h.complete(base, { model: 'helper', messages: [QUESTION], tools: [ASK_USER, PICK_DATE] });
    expect(response.status).toBe(HttpStatus.BadRequest);
    const { error } = await response.json();
    expect(error).toMatchObject({ param: 'tools', message: 'tools: send at most 1 with one request.' });
    expect(await h.db.select().from(runs)).toEqual([]);
    const oneTool = await h.complete(base, { model: 'helper', messages: [QUESTION], tools: [ASK_USER] });
    expect(oneTool.status).toBe(HttpStatus.Ok);
  });

  it('answers a repeated Idempotency-Key with the hand-back while the run waits', async () => {
    h.script = ASK_SCRIPT;
    const { base } = await h.startRouter();
    const first = await handBack(base, {}, { 'idempotency-key': 'ask-1' });
    const again = await h.complete(
      base,
      { model: 'helper', messages: [QUESTION], tools: [ASK_USER] },
      { 'idempotency-key': 'ask-1' },
    );
    expect(again.headers.get('x-run-id')).toBe(first.runId);
    expect(await again.json()).toEqual(first.answer);
    expect(h.received).toHaveLength(1);
  });

  it('still carries on after a restart, from the run kept in the database', async () => {
    h.script = ASK_SCRIPT;
    const before = await h.startRouter();
    const { runId, message, calls } = await handBack(before.base);
    await before.runs.stop();
    const after = await h.startRouter();
    expect(await after.runs.recover()).toBe(0);
    const resumed = await h.complete(after.base, answering(message, { [calls[0]?.id ?? '']: 'red' }));
    expect(resumed.headers.get('x-run-id')).toBe(runId);
    expect((await resumed.json()).choices[0].message.content).toBe('The app said: red');
    const events = await eventsOf(after.base, runId);
    expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index + 1));
    expect(events.at(-1)).toMatchObject({ kind: 'done', ok: true });
  });
});
