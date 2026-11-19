import { describe, expect, it } from 'vitest';
import { inputMessagesOf } from '../../web/runs/input.ts';
import { formatDuration, shortError, statusOf } from '../../web/runs/shapes.ts';
import { type TimelineEvent, timelineOf } from '../../web/runs/timeline.ts';

// The run page draws agent-core's RunEvents as a timeline: live ones as they come, and stored ones, which are folded.

/**
 * Builds an event with every field a watcher receives.
 *
 * @param seq - Its place in the run.
 * @param fields - What sets it apart.
 * @returns The event.
 */
function event(seq: number, fields: Partial<TimelineEvent> & Pick<TimelineEvent, 'kind'>): TimelineEvent {
  return { seq, at: 1000 + seq, text: '', name: '', id: null, exchange: '', ok: null, usage: null, ...fields };
}

describe('timelineOf', () => {
  it('gathers streamed text into one entry per run of it', () => {
    const entries = timelineOf([
      event(1, { kind: 'turn', text: 'turn 1' }),
      event(2, { kind: 'thinking', text: 'Let me ' }),
      event(3, { kind: 'thinking', text: 'look.' }),
      event(4, { kind: 'output', text: 'Hello ' }),
      event(5, { kind: 'output', text: 'there.' }),
    ]);
    expect(entries.map((entry) => entry.type)).toEqual(['turn', 'thinking', 'output']);
    expect(entries[1]).toMatchObject({ text: 'Let me look.', key: 2 });
    expect(entries[2]).toMatchObject({ text: 'Hello there.', key: 4 });
  });

  it('draws stored events, each stretch folded under its last seq, as it draws the deltas', () => {
    const deltas = [
      event(1, { kind: 'turn', text: 'turn 1' }),
      event(2, { kind: 'thinking', text: 'Let me ' }),
      event(3, { kind: 'thinking', text: 'look.' }),
      event(4, { kind: 'output', text: 'Hello ' }),
      event(5, { kind: 'output', text: 'there.' }),
      event(6, { kind: 'done', ok: true }),
    ];
    const folded = [
      event(1, { kind: 'turn', text: 'turn 1' }),
      event(3, { kind: 'thinking', text: 'Let me look.' }),
      event(5, { kind: 'output', text: 'Hello there.' }),
      event(6, { kind: 'done', ok: true }),
    ];
    // A page that opens mid-stretch gets the stored part folded, then the rest live.
    const joined = [event(4, { kind: 'output', text: 'Hello ' }), event(5, { kind: 'output', text: 'there.' })];
    const mixed = [...folded.slice(0, 2), ...joined, folded[3] ?? event(6, { kind: 'done' })];
    const shown = (events: TimelineEvent[]) =>
      timelineOf(events).map((entry) => [entry.type, 'text' in entry ? entry.text : '']);
    expect(shown(folded)).toEqual(shown(deltas));
    expect(shown(mixed)).toEqual(shown(deltas));
  });

  it('joins each tool call to its result and log lines by the call id', () => {
    const entries = timelineOf([
      event(1, { kind: 'tool-call', name: 'fs__read', id: 'a', text: '{"path":"x"}' }),
      event(2, { kind: 'tool-call', name: 'fs__read', id: 'b', text: '{"path":"y"}' }),
      event(3, { kind: 'server-log', name: 'fs__read', id: 'a', level: 'warning', text: 'slow disk' }),
      event(4, { kind: 'tool-result', name: 'fs__read', id: 'b', ok: false, text: 'no such file' }),
      event(5, { kind: 'tool-result', name: 'fs__read', id: 'a', ok: true, text: 'contents' }),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      type: 'tool',
      args: '{"path":"x"}',
      result: 'contents',
      ok: true,
      logs: [{ level: 'warning', text: 'slow disk' }],
    });
    expect(entries[1]).toMatchObject({ type: 'tool', result: 'no such file', ok: false });
  });

  it('leaves a call open until its result arrives', () => {
    const [call] = timelineOf([event(1, { kind: 'tool-call', name: 'echo', id: 'a' })]);
    expect(call).toMatchObject({ type: 'tool', result: null, ok: null });
  });

  it('orders events by seq and drops repeats, as a reconnect may deliver them twice', () => {
    const entries = timelineOf([
      event(2, { kind: 'notice', text: 'second' }),
      event(1, { kind: 'notice', text: 'first' }),
      event(2, { kind: 'notice', text: 'second' }),
    ]);
    expect(entries.map((entry) => (entry.type === 'note' ? entry.text : ''))).toEqual(['first', 'second']);
  });

  it('keeps each entry in the exchange it happened in', () => {
    const entries = timelineOf([
      event(1, { kind: 'exchange', name: 'plan', text: 'agent' }),
      event(2, { kind: 'output', exchange: 'plan', text: 'a' }),
      event(3, { kind: 'output', exchange: 'write', text: 'b' }),
    ]);
    expect(entries.map((entry) => [entry.type, entry.exchange])).toEqual([
      ['exchange', ''],
      ['output', 'plan'],
      ['output', 'write'],
    ]);
  });

  it('draws a kind it does not know as a note rather than dropping it', () => {
    const [entry] = timelineOf([event(1, { kind: 'compaction', text: 'folded 12 messages' })]);
    expect(entry).toMatchObject({ type: 'note', kind: 'compaction', text: 'folded 12 messages' });
  });

  it('reads usage per turn', () => {
    const events = [
      event(1, {
        kind: 'usage',
        usage: { promptTokens: 10, completionTokens: 5, turn: { prompt: 10, completion: 5 } },
      }),
      event(2, { kind: 'usage', usage: { promptTokens: 30, completionTokens: 9 } }),
      event(3, { kind: 'done', ok: true }),
    ];
    expect(timelineOf(events)[0]).toMatchObject({ type: 'usage', usage: { turn: { prompt: 10, completion: 5 } } });
  });
});

describe('run shapes', () => {
  it('writes durations the way a person reads them', () => {
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(12_000)).toBe('12 s');
    expect(formatDuration(184_000)).toBe('3 min 4 s');
    expect(formatDuration(3_720_000)).toBe('1 h 2 min');
  });

  it('shortens an error to its first line', () => {
    expect(shortError('Provider said no.\nstack...')).toBe('Provider said no.');
    expect(shortError('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('reads only the statuses the filter offers from the address bar', () => {
    expect(statusOf('failed')).toBe('failed');
    expect(statusOf('nonsense')).toBeUndefined();
  });
});

describe('run input', () => {
  it("reads a run's input messages, and leaves out anything that is not one", () => {
    const messages = inputMessagesOf([
      { role: 'system', content: 'You are in task_server.' },
      { role: 'user', content: 'And this receipt?', images: 1 },
      { role: 'tool', content: 'blue', toolCallId: 'abc' },
      { role: 'assistant', content: 'not input' },
      'nonsense',
    ]);
    expect(messages).toEqual([
      { role: 'system', content: 'You are in task_server.', toolCallId: null, images: 0 },
      { role: 'user', content: 'And this receipt?', toolCallId: null, images: 1 },
      { role: 'tool', content: 'blue', toolCallId: 'abc', images: 0 },
    ]);
    expect(inputMessagesOf(null)).toEqual([]);
  });
});
