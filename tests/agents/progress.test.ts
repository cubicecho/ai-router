import { fold, type RunEvent } from '@cubicecho/agent-core';
import { describe, expect, it } from 'vitest';
import { dataLines, ECHO, QUESTION, useRunHarness } from './run-harness.ts';

// With ai_router.progress, the answer carries the run's events: as chunks with empty choices in a stream, and as
// ai_router.events beside choices otherwise. A standard client sees what it always saw.

const h = useRunHarness();

/** A streamed chunk, as far as these tests read it. */
interface Chunk {
  object: string;
  choices: { delta: { content?: string } }[];
  ai_router?: { event: RunEvent };
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
      ai_router: { progress: true },
    });
    const runId = response.headers.get('x-run-id');
    const lines = await dataLines(response);
    expect(lines.at(-1)).toBe('[DONE]');
    const chunks = lines.slice(0, -1) as Chunk[];
    expect(chunks.every((chunk) => chunk.object === 'chat.completion.chunk')).toBe(true);
    const progress = chunks.filter((chunk) => chunk.ai_router !== undefined);
    expect(progress.every((chunk) => chunk.choices.length === 0)).toBe(true);
    const events = progress.flatMap((chunk) => (chunk.ai_router === undefined ? [] : [chunk.ai_router.event]));
    expectWhole(events, runId);
    const text = chunks.flatMap((chunk) => chunk.choices.map((choice) => choice.delta.content ?? '')).join('');
    expect(text).toBe('The tool said: hello there');
    // The app got every delta. What is stored is the same events, each stretch of streamed text folded into one.
    const stored = await (await h.get(`${base}/runs/${runId}/events`)).json();
    expect(stored.events).toEqual(fold(events));
    expect(stored.events.length).toBeLessThan(events.length);
  });

  it('puts the events beside choices in an answer that is not streamed', async () => {
    const { base } = await h.startRouter();
    const response = await h.complete(base, { model: 'helper', messages: [QUESTION], ai_router: { progress: true } });
    const runId = response.headers.get('x-run-id');
    const answer = await response.json();
    expect(answer.choices[0].message.content).toBe('The tool said: hello there');
    expect(answer.ai_router.runId).toBe(runId);
    expectWhole(answer.ai_router.events, runId);
  });

  it('leaves a standard client’s answer as it was', async () => {
    const { base } = await h.startRouter();
    const plain = await (await h.complete(base, { model: 'helper', messages: [QUESTION] })).json();
    expect(plain).not.toHaveProperty('ai_router');
    const streamed = await dataLines(await h.complete(base, { model: 'helper', messages: [QUESTION], stream: true }));
    const chunks = streamed.slice(0, -1) as Chunk[];
    expect(chunks.some((chunk) => chunk.ai_router !== undefined || chunk.choices.length === 0)).toBe(false);
  });
});
