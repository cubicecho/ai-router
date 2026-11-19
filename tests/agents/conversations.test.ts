import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { HttpStatus } from '../../server/core/wire.ts';
import { conversations } from '../../server/db/tables/conversations.ts';
import { runs } from '../../server/db/tables/runs.ts';
import { CREATE_AGENT, GRANT, lastMessage, type Reply, sentMessages, until, useRunHarness } from './run-harness.ts';

// X-Conversation-Id: the router keeps the history, so the app sends only what is new, and one run at a time.

const h = useRunHarness();

/** Answers every question straight away, naming it. */
const ANSWER_SCRIPT = (body: Record<string, unknown>): Reply => ({ content: `You said: ${lastMessage(body).content}` });

/**
 * Asks with a conversation id.
 *
 * @param base - The router.
 * @param key - The conversation.
 * @param messages - What the app sends.
 * @param [extra] - More of the body.
 * @returns The answer.
 */
function say(base: string, key: string, messages: unknown[], extra: Record<string, unknown> = {}) {
  return h.complete(base, { model: 'helper', messages, ...extra }, { 'x-conversation-id': key });
}

describe('conversations', () => {
  it('keeps the history, so the app sends only new messages, and the host text it started with', async () => {
    h.script = ANSWER_SCRIPT;
    const { base } = await h.startRouter();
    const host = { role: 'system', content: 'You are in min-agent.' };
    const first = await say(base, 'chat-1', [host, { role: 'user', content: 'one' }]);
    expect((await first.json()).choices[0].message.content).toBe('You said: one');
    const second = await say(base, 'chat-1', [{ role: 'user', content: 'two' }]);
    const secondRunId = second.headers.get('x-run-id');
    expect((await second.json()).choices[0].message.content).toBe('You said: two');
    const sent = sentMessages(h.received[1]);
    expect(sent[0]?.content).toContain('You are in min-agent.');
    expect(sent.slice(1)).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'You said: one' },
      { role: 'user', content: 'two' },
    ]);
    const [row] = await h.db.select().from(conversations);
    expect(row).toMatchObject({ key: 'chat-1', agentName: 'helper', hostText: 'You are in min-agent.' });
    expect(row?.messages).toHaveLength(4);
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    // A run names its conversation, and a conversation its runs.
    const record = await (await h.get(`${base}/runs/${secondRunId}`)).json();
    expect(record.conversation).toBe('chat-1');
    // Each run keeps what its own request added, never the history the router put in front of it.
    expect(record.input).toEqual([{ role: 'user', content: 'two' }]);
    const firstRecord = await (await h.get(`${base}/runs/${first.headers.get('x-run-id')}`)).json();
    expect(firstRecord.input).toEqual([host, { role: 'user', content: 'one' }]);
    const { conversations: listed } = await h.asUser.expectOk('{ conversations { key runs { id } } }');
    expect(listed).toEqual([{ key: 'chat-1', runs: expect.arrayContaining([{ id: secondRunId }]) }]);
    expect(listed[0].runs).toHaveLength(2);
  });

  it('answers 409 to a request that overlaps a running run of the same conversation', async () => {
    h.script = (body) =>
      lastMessage(body).role === 'tool'
        ? { content: 'awake' }
        : { call: { name: 'fix_ture__sleep', args: { ms: 300 } } };
    const { base } = await h.startRouter();
    const first = say(base, 'busy', [{ role: 'user', content: 'one' }]);
    await until(() => h.received.length > 0, 'the first run to start');
    const overlap = await say(base, 'busy', [{ role: 'user', content: 'two' }]);
    expect(overlap.status).toBe(HttpStatus.Conflict);
    expect((await overlap.json()).error.code).toBe('conversation_busy');
    expect((await (await first).json()).choices[0].message.content).toBe('awake');
    // Another conversation, and the same one once it is free, are let through.
    expect((await say(base, 'other', [{ role: 'user', content: 'x' }])).status).toBe(HttpStatus.Ok);
    expect((await say(base, 'busy', [{ role: 'user', content: 'three' }])).status).toBe(HttpStatus.Ok);
  });

  it('answers 409 while a run of it waits, and lets the answer to its calls resume it', async () => {
    h.script = (body) =>
      lastMessage(body).role === 'tool'
        ? { content: `Noted: ${lastMessage(body).content}` }
        : { call: { name: 'ask_user', args: { question: 'Colour?' } } };
    const tools = [{ type: 'function', function: { name: 'ask_user', parameters: { type: 'object' } } }];
    const { base } = await h.startRouter();
    const handed = await (await say(base, 'chat', [{ role: 'user', content: 'paint' }], { tools })).json();
    const [call] = handed.choices[0].message.tool_calls;
    const meanwhile = await say(base, 'chat', [{ role: 'user', content: 'hello?' }], { tools });
    expect(meanwhile.status).toBe(HttpStatus.Conflict);
    const answered = await say(base, 'chat', [{ role: 'tool', tool_call_id: call.id, content: 'teal' }], { tools });
    expect((await answered.json()).choices[0].message.content).toBe('Noted: teal');
    const [row] = await h.db.select().from(conversations);
    expect(row?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    // A run of one conversation can't be answered under another.
    await say(base, 'chat-2', [{ role: 'user', content: 'paint' }], { tools });
    const [second] = await h.db.select().from(runs).where(eq(runs.status, 'waiting'));
    const pending = second?.pendingCallIds[0] ?? '';
    const crossed = await say(base, 'chat', [{ role: 'tool', tool_call_id: pending, content: 'red' }], { tools });
    expect(crossed.status).toBe(HttpStatus.BadRequest);
    expect((await crossed.json()).error.param).toBe('X-Conversation-Id');
  });

  it('refuses history sent again to a conversation that keeps its own, and another agent joining it', async () => {
    h.script = ANSWER_SCRIPT;
    const { base } = await h.startRouter();
    await (await say(base, 'chat', [{ role: 'user', content: 'one' }])).json();
    const resent = await say(base, 'chat', [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'You said: one' },
      { role: 'user', content: 'two' },
    ]);
    expect(resent.status).toBe(HttpStatus.BadRequest);
    const { error } = await resent.json();
    expect(error.param).toBe('messages');
    expect(error.message).toContain('send only what is new');

    const { createAgent } = await h.asUser.expectOk(CREATE_AGENT, {
      document: { spec: 'cubicecho.agent/1', id: 'other', model: { model: 'fake/m1' }, tools: { servers: [] } },
    });
    await h.asUser.expectOk(GRANT, { v: { workspaceId: h.workspaceId, agentId: createAgent.id } });
    await h.snapshot.rebuild();
    const joined = await h.complete(
      base,
      { model: 'other', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-conversation-id': 'chat' },
    );
    expect(joined.status).toBe(HttpStatus.BadRequest);
    expect((await joined.json()).error).toMatchObject({ param: 'X-Conversation-Id' });
    expect((await say(base, 'has space', [{ role: 'user', content: 'x' }])).status).toBe(HttpStatus.BadRequest);
  });

  it('starts an expired conversation again, and prunes expired ones while their runs stay', async () => {
    h.script = ANSWER_SCRIPT;
    const { base, runs: runService } = await h.startRouter();
    const first = await say(base, 'old', [{ role: 'user', content: 'one' }]);
    const runId = first.headers.get('x-run-id') ?? '';
    await first.json();
    const past = new Date(Date.now() - 1000);
    await h.db.update(conversations).set({ expiresAt: past });
    await (await say(base, 'old', [{ role: 'user', content: 'fresh' }])).json();
    expect(sentMessages(h.received[1]).slice(1)).toEqual([{ role: 'user', content: 'fresh' }]);

    await h.db.update(conversations).set({ expiresAt: past });
    await runService.prune();
    expect(await h.db.select().from(conversations)).toEqual([]);
    const [kept] = await h.db.select().from(runs).where(eq(runs.id, runId));
    expect(kept).toMatchObject({ id: runId, conversationId: null });
  });
});
