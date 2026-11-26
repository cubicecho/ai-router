import { describe, expect, it } from 'vitest';
import { modelOptionsOf, type ProviderChoice } from '../../web/agents/model-options.ts';

/**
 * Makes a provider that has answered.
 *
 * @param name - Its name.
 * @param models - What it serves.
 * @returns The provider.
 */
function answered(name: string, models: string[]): ProviderChoice {
  return { name, enabled: true, models, error: undefined };
}

describe("the agent editor's Model field", () => {
  it('offers each pool by name, then each model as <provider>/<model> under its provider', () => {
    const options = modelOptionsOf(
      [{ name: 'fast', enabled: true }],
      [answered('ollama', ['qwen3:8b', 'qwen3:32b']), answered('openai', ['gpt-5'])],
    );
    expect(options.map((option) => ('value' in option ? [option.value, option.group] : option))).toEqual([
      ['fast', 'Pools'],
      ['ollama/qwen3:8b', 'ollama'],
      ['ollama/qwen3:32b', 'ollama'],
      ['openai/gpt-5', 'openai'],
    ]);
  });

  it('keeps a turned-off pool, saying why it would not run', () => {
    const [pool] = modelOptionsOf([{ name: 'slow', enabled: false }], []);
    expect(pool).toMatchObject({ value: 'slow', hint: expect.stringContaining('Turned off') });
  });

  it('puts a note, never a choice, for a provider still answering, failing or turned off', () => {
    const options = modelOptionsOf(
      [],
      [
        { name: 'busy', enabled: true, models: undefined, error: undefined },
        { name: 'down', enabled: true, models: undefined, error: 'connection refused' },
        { name: 'off', enabled: false, models: undefined, error: undefined },
      ],
    );
    expect(options.every((option) => 'note' in option)).toBe(true);
    expect(options).toHaveLength(3);
    expect(options[1]).toMatchObject({ note: 'down: connection refused', className: 'text-negative' });
  });
});
