import { describe, expect, it } from 'vitest';
import { readUsage, UsageReader } from '../../server/models/usage-reader.ts';

const encode = (text: string) => new TextEncoder().encode(text);

describe('readUsage', () => {
  it('reads chat completion counts', () => {
    expect(readUsage({ usage: { prompt_tokens: 3, completion_tokens: 4 } })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    });
  });

  it('reads the responses API, nested in its stream events', () => {
    expect(readUsage({ response: { usage: { input_tokens: 5, output_tokens: 6 } } })).toEqual({
      inputTokens: 5,
      outputTokens: 6,
    });
  });

  it('counts a missing side as zero, as an embedding has', () => {
    expect(readUsage({ usage: { prompt_tokens: 7 } })).toEqual({ inputTokens: 7, outputTokens: 0 });
  });

  it.each([null, {}, { usage: {} }, { usage: { prompt_tokens: -1 } }])('finds nothing in %j', (json) => {
    expect(readUsage(json)).toBeUndefined();
  });
});

describe('UsageReader', () => {
  it('reads a JSON answer that arrives in pieces', () => {
    const reader = new UsageReader(false, 1000);
    reader.push(encode('{"usage":{"prompt_'));
    reader.push(encode('tokens":1,"completion_tokens":2}}'));
    expect(reader.result()).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  it('stops reading a JSON answer past the limit', () => {
    const reader = new UsageReader(false, 10);
    reader.push(encode('{"usage":{"prompt_tokens":1,"completion_tokens":2}}'));
    expect(reader.result()).toBeUndefined();
  });

  it('reads a stream split across chunks, the last report winning, with no final newline', () => {
    const reader = new UsageReader(true, 10);
    reader.push(encode('data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: {"choices":[]}\n\nda'));
    reader.push(encode('ta: {"usage":{"prompt_tokens":9,"completion_tokens":8}}'));
    expect(reader.result()).toEqual({ inputTokens: 9, outputTokens: 8 });
  });
});
