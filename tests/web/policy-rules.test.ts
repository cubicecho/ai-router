import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_RULES } from '../../server/agents/policy.ts';
import { rulesOf, summaryOf } from '../../web/policies/rules.ts';

// The policies page reads a policy's stored rules, and says in a line what it lets an app do.

describe("a policy's rules", () => {
  it('read as stored, and anything missing or mistyped as not allowed', () => {
    expect(rulesOf(DEFAULT_POLICY_RULES)).toEqual(DEFAULT_POLICY_RULES);
    expect(rulesOf({ hostPrompt: 'yes', sampling: ['seed', 3] })).toEqual({
      hostPrompt: false,
      taskPrompt: false,
      narrowServers: false,
      sampling: ['seed'],
      responseFormat: false,
    });
    expect(rulesOf(null).sampling).toEqual([]);
  });

  it('say what they allow, or that they allow nothing', () => {
    expect(summaryOf(rulesOf({ hostPrompt: true, sampling: ['seed'] }))).toBe(
      'An app may send system messages and 1 sampling field.',
    );
    expect(summaryOf(rulesOf({ taskPrompt: true }))).toBe('An app may send the task.');
    expect(summaryOf(rulesOf({}))).toBe('An app may change nothing.');
  });
});
