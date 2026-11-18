import { describe, expect, it } from 'vitest';
import { readFrames } from '../../web/lib/sse.ts';

// The UI follows a run's events over graphql-yoga's server-sent events, read a chunk at a time.

describe('readFrames', () => {
  it('reads a result frame and the frame that ends it, as Yoga sends them', () => {
    const read = readFrames('event: next\ndata: {"data":{"x":1}}\n\nevent: complete\ndata:\n\n');
    expect(read.frames).toEqual([
      { event: 'next', data: '{"data":{"x":1}}' },
      { event: 'complete', data: '' },
    ]);
    expect(read.rest).toBe('');
  });

  it('keeps a frame cut between chunks until its end arrives', () => {
    const first = readFrames('event: next\ndata: {"da');
    expect(first.frames).toEqual([]);
    const second = readFrames(`${first.rest}ta":1}\n\n`);
    expect(second.frames).toEqual([{ event: 'next', data: '{"data":1}' }]);
  });

  it('skips keep-alive comments and reads a frame with no event as a message', () => {
    const read = readFrames(':\n\ndata: a\ndata: b\n\n');
    expect(read.frames).toEqual([{ event: 'message', data: 'a\nb' }]);
  });

  it('reads CRLF line endings', () => {
    expect(readFrames('event: next\r\ndata: 1\r\n\r\n').frames).toEqual([{ event: 'next', data: '1' }]);
  });
});
