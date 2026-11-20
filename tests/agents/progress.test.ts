import { fold, type RunEvent } from '@cubicecho/agent-core';
import { describe, expect, it } from 'vitest';
import { dataLines, ECHO, QUESTION, useRunHarness } from './run-harness.ts';

// With agent_core.progress, the answer carries the run's events: as chunks with empty choices in a stream, and as
// agent_core.events beside choices otherwise. A standard client sees what it always saw, and a streamed one the
// run's work as reasoning.

const h = useRunHarness();

/** A streamed chunk, as far as these tests read it. */
interface Chunk {
  object: string;
  choices: { delta: { content?: string; reasoning_content?: string }; finish_reason: string | null }[];
  agent_core?: { event?: RunEvent; warnings?: { part: string; rule: string; message: string }[] };
}

/**
 * Checks that events are one run's, in order, from 1, with no gap, ending in its `done`.
 *
 * @param events - The events.
 * @param runId - The run.
 */
function expectWhole(events: RunEvent[], runId: string | null): void {
  expect(events.map((event) => event.seq)).toEqual(events.map((_event, index) => index + 1));
  expect(events.every((event) => event.runId === runId)).toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ kind: 'tool-call', name: ECHO }));
  expect(events.at(-1)).toMatchObject({ kind: 'done', ok: true });
}

describe('progress events', () => {
  it('streams each event as a chunk with empty choices, between the content chunks', async () => {
    const { base } = await h.startRouter();
    const response = await h.complete(base, {
      model: 'helper',
      messages: [QUESTION],
      stream: true,
      agent_core: { progress: true },
    });
    const runId = response.headers.get('x-run-id');
    const lines = await dataLines(response);
    expect(lines.at(-1)).toBe('[DONE]');
    const chunks = lines.slice(0, -1) as Chunk[];
    expect(chunks.every((chunk) => chunk.object === 'chat.completion.chunk')).toBe(true);
    const progress = chunks.filter((chunk) => chunk.agent_core !== undefined);
    expect(progress.every((chunk) => chunk.choices.length === 0)).toBe(true);
    const events = progress.flatMap((chunk) => chunk.agent_core?.event ?? []);
    expectWhole(events, runId);
    const text = chunks.flatMap((chunk) => chunk.choices.map((choice) => choice.delta.content ?? '')).join('');
    expect(text).toBe('The tool said: hello there');
    // The events are the work, so it isn't written as reasoning too.
    expect(chunks.some((chunk) => chunk.choices.some((choice) => choice.delta.reasoning_content !== undefined))).toBe(
      false,
    );
    // The app got every delta. What is stored is the same events, each stretch of streamed text folded into one.
    const stored = await (await h.get(`${base}/runs/${runId}/events`)).json();
    expect(stored.events).toEqual(fold(events));
    expect(stored.events.length).toBeLessThan(events.length);
  });

  it('puts the events beside choices in an answer that is not streamed', async () => {
    const { base } = await h.startRouter();
    const response = await h.complete(base, { model: 'helper', messages: [QUESTION], agent_core: { progress: true } });
    const runId = response.headers.get('x-run-id');
    const answer = await response.json();
    expect(answer.choices[0].message.content).toBe('The tool said: hello there');
    expect(answer.agent_core.runId).toBe(runId);
    expectWhole(answer.agent_core.events, runId);
  });

  it('leaves a standard client’s answer as it was', async () => {
    const { base } = await h.startRouter();
    const plain = await (await h.complete(base, { model: 'helper', messages: [QUESTION] })).json();
    expect(plain).not.toHaveProperty('agent_core');
    const streamed = await dataLines(await h.complete(base, { model: 'helper', messages: [QUESTION], stream: true }));
    const chunks = streamed.slice(0, -1) as Chunk[];
    expect(chunks.some((chunk) => chunk.agent_core !== undefined || chunk.choices.length === 0)).toBe(false);
  });

  it('streams the run’s tool calls to a client that asks for no progress as reasoning, beside the answer', async () => {
    const { base } = await h.startRouter();
    const lines = await dataLines(await h.complete(base, { model: 'helper', messages: [QUESTION], stream: true }));
    const chunks = lines.slice(0, -1) as Chunk[];
    const reasoning = chunks.flatMap((chunk) => chunk.choices.map((choice) => choice.delta.reasoning_content ?? ''));
    expect(reasoning.join('')).toContain(`Calling \`${ECHO}\`…`);
    expect(reasoning.join('')).toContain(`\`${ECHO}\` came back.`);
    const text = chunks.flatMap((chunk) => chunk.choices.map((choice) => choice.delta.content ?? '')).join('');
    expect(text).toBe('The tool said: hello there');
  });
});

describe('warnings about app parts', () => {
  // The harness's agent has one part, `role`, which lists no modes: an app may extend it, and not replace it.
  const REPLACING = {
    agent_core: { prompt: [{ role: 'system', name: 'role', mode: 'replace', content: 'Be terse.' }] },
  };
  const WARNING = { part: 'role', rule: 'replace-not-allowed', message: expect.stringContaining('replace') };

  it('come beside choices in an answer that is not streamed, and the run still answers', async () => {
    const { base } = await h.startRouter();
    const answer = await (await h.complete(base, { model: 'helper', messages: [QUESTION], ...REPLACING })).json();
    expect(answer.choices[0].message.content).toBe('The tool said: hello there');
    expect(answer.agent_core).toEqual({ warnings: [WARNING] });
  });

  it('come on the finish chunk of a stream, and as a notice in the run’s events', async () => {
    const { base } = await h.startRouter();
    const response = await h.complete(base, { model: 'helper', messages: [QUESTION], stream: true, ...REPLACING });
    const runId = response.headers.get('x-run-id');
    const chunks = (await dataLines(response)).slice(0, -1) as Chunk[];
    const finish = chunks.find((chunk) => chunk.choices.some((choice) => choice.finish_reason !== null));
    expect(finish?.agent_core).toEqual({ warnings: [WARNING] });
    const stored = await (await h.get(`${base}/runs/${runId}/events`)).json();
    expect(stored.events).toContainEqual(expect.objectContaining({ kind: 'notice', text: WARNING.message }));
  });
});
