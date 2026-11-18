import { describe, expect, it } from 'vitest';
import { affinityKey } from '../../server/models/affinity.ts';
import { modelId, splitModelId } from '../../server/models/naming.ts';

describe('model ids', () => {
  it('splits at the first slash, so a model id may hold more', () => {
    expect(splitModelId('openrouter/meta/llama-3')).toEqual({ providerName: 'openrouter', model: 'meta/llama-3' });
  });

  it.each(['qwen3', '/llama', 'ollama/'])('reads %j as no provider model', (id) => {
    expect(splitModelId(id)).toBeNull();
  });

  it('builds what it splits', () => {
    expect(splitModelId(modelId('ollama', 'qwen3:8b'))).toEqual({ providerName: 'ollama', model: 'qwen3:8b' });
  });
});

describe('affinityKey', () => {
  const chat = (...contents: string[]) => ({
    messages: [{ role: 'system', content: 'Be brief.' }, ...contents.map((content) => ({ role: 'user', content }))],
  });

  it('trusts the session header, then prompt_cache_key, then user', () => {
    const body = { prompt_cache_key: 'cache', user: 'ada', ...chat('hi') };
    expect(affinityKey(body, 'session')).toBe('session');
    expect(affinityKey(body, null)).toBe('cache');
    expect(affinityKey({ user: 'ada', ...chat('hi') }, null)).toBe('ada');
  });

  it('keeps a growing chat on one key', () => {
    expect(affinityKey(chat('hi', 'and more'), null)).toBe(affinityKey(chat('hi'), null));
  });

  it('hashes the prompt, so a large opening is a short key', () => {
    const key = affinityKey(chat('x'.repeat(1_000_000)), null);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keys a completion by its prompt and an embedding by its input', () => {
    expect(affinityKey({ prompt: 'a' }, null)).toBe(affinityKey({ input: 'a' }, null));
  });

  it('has no key for a body with nothing to key on', () => {
    expect(affinityKey({ model: 'x' }, null)).toBeNull();
  });
});
