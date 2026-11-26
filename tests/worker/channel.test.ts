import { describe, expect, it, vi } from 'vitest';
import { ChannelMessageType } from '../../server/runner/protocol.ts';
import { parseChannelMessage } from '../../worker/channel.ts';

describe('a channel message', () => {
  it('takes its type from the event name, with or without it in the data', () => {
    const assignment = { runId: 'run-1', targets: {} };
    expect(parseChannelMessage('assign', JSON.stringify({ assignment }))).toEqual({
      type: ChannelMessageType.Assign,
      assignment,
    });
    expect(parseChannelMessage('assign', JSON.stringify({ type: 'assign', assignment }))).toEqual({
      type: ChannelMessageType.Assign,
      assignment,
    });
    expect(parseChannelMessage('cancel', JSON.stringify({ runId: 'run-1', reason: 'gone' }))).toEqual({
      type: ChannelMessageType.Cancel,
      runId: 'run-1',
      reason: 'gone',
    });
    expect(parseChannelMessage('ping', '')).toEqual({ type: ChannelMessageType.Ping });
  });

  it('is ignored when it is unknown or unreadable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(parseChannelMessage('assign', '{ nope')).toBeUndefined();
      expect(parseChannelMessage('assign', JSON.stringify({ assignment: {} }))).toBeUndefined();
      expect(parseChannelMessage('later', '{}')).toBeUndefined();
      expect(warn.mock.calls).toHaveLength(3);
    } finally {
      warn.mockRestore();
    }
  });
});
