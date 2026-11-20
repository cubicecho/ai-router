import { describe, expect, it } from 'vitest';
import { documentFrom, formValuesOf, isPromptEditable, ServerReach } from '../../web/agents/agent-form.ts';

/** A document with something in every part the form shows, and parts it doesn't. */
const DOCUMENT = {
  spec: 'cubicecho.agent/2',
  id: 'personal-finance',
  name: 'Personal finance',
  description: 'Answers from the budget.',
  endpoint: { requestTimeoutSeconds: 30 },
  model: { model: 'ollama/qwen3:32b', temperature: 0, maxTokens: 2048, extraBody: { top_k: 20 } },
  prompt: [
    { role: 'system', name: 'identity', content: 'You help with money.' },
    { role: 'developer', name: 'rules', content: 'Only from the documents.', allowedModes: [] },
    { role: 'system', name: 'format', content: 'A short table.', allowedModes: ['extend', 'replace'] },
  ],
  promptLayout: 'xml',
  tools: { servers: ['actual', 'finance-docs'], maxIterations: 12, discovery: 'ondemand' },
  tasks: { compact: { model: '' } },
  extensions: { 'com.example': { lane: 3 } },
};

describe('formValuesOf', () => {
  it('reads the parts the form shows', () => {
    expect(formValuesOf(DOCUMENT)).toEqual({
      id: 'personal-finance',
      name: 'Personal finance',
      description: 'Answers from the budget.',
      model: 'ollama/qwen3:32b',
      temperature: 0,
      maxTokens: 2048,
      reasoningEffort: '',
      prompt: [
        { role: 'system', name: 'identity', content: 'You help with money.', appsExtend: true, appsReplace: false },
        {
          role: 'developer',
          name: 'rules',
          content: 'Only from the documents.',
          appsExtend: false,
          appsReplace: false,
        },
        { role: 'system', name: 'format', content: 'A short table.', appsExtend: true, appsReplace: true },
      ],
      promptLayout: 'xml',
      serverReach: ServerReach.Chosen,
      servers: ['actual', 'finance-docs'],
      maxIterations: 12,
    });
  });

  it('reads tools.servers as its three meanings', () => {
    expect(formValuesOf({}).serverReach).toBe(ServerReach.Every);
    expect(formValuesOf({ tools: { servers: [] } }).serverReach).toBe(ServerReach.None);
    expect(formValuesOf({ tools: { servers: ['git'] } }).serverReach).toBe(ServerReach.Chosen);
  });

  it('leaves a field blank where the document leaves it out', () => {
    expect(formValuesOf({ spec: 'cubicecho.agent/2' })).toMatchObject({
      id: '',
      model: '',
      temperature: null,
      prompt: [],
      promptLayout: 'plain',
      maxIterations: null,
    });
  });
});

describe('documentFrom', () => {
  it('gives back the same document when nothing was changed', () => {
    expect(documentFrom(DOCUMENT, formValuesOf(DOCUMENT))).toEqual(DOCUMENT);
  });

  it("keeps everything the form doesn't show", () => {
    const changed = documentFrom(DOCUMENT, { ...formValuesOf(DOCUMENT), model: 'openai/gpt-5.1', temperature: 0.4 });
    expect(changed).toMatchObject({
      endpoint: DOCUMENT.endpoint,
      tasks: DOCUMENT.tasks,
      extensions: DOCUMENT.extensions,
      model: { model: 'openai/gpt-5.1', temperature: 0.4, maxTokens: 2048, extraBody: { top_k: 20 } },
      tools: { discovery: 'ondemand' },
    });
  });

  it('writes the three meanings of tools.servers, never collapsing one into another', () => {
    const values = formValuesOf(DOCUMENT);
    const every = documentFrom(DOCUMENT, { ...values, serverReach: ServerReach.Every });
    expect(every.tools).toEqual({ maxIterations: 12, discovery: 'ondemand' });
    const none = documentFrom(DOCUMENT, { ...values, serverReach: ServerReach.None });
    expect(none.tools).toMatchObject({ servers: [] });
    const chosen = documentFrom(DOCUMENT, { ...values, servers: ['git'] });
    expect(chosen.tools).toMatchObject({ servers: ['git'] });
  });

  it('leaves out a blank field, and keeps a zero', () => {
    const blank = documentFrom(DOCUMENT, {
      ...formValuesOf(DOCUMENT),
      name: '  ',
      description: '',
      maxTokens: null,
      temperature: 0,
    });
    expect(blank).not.toHaveProperty('name');
    expect(blank).not.toHaveProperty('description');
    expect(blank.model).toEqual({ model: 'ollama/qwen3:32b', temperature: 0, extraBody: { top_k: 20 } });
  });

  it('leaves out a model or tools the form emptied', () => {
    const bare = { spec: 'cubicecho.agent/2', id: 'a', model: { model: 'p/m' }, tools: { maxIterations: 3 } };
    const emptied = documentFrom(bare, {
      ...formValuesOf(bare),
      model: '',
      maxIterations: null,
      serverReach: ServerReach.Every,
    });
    expect(emptied).toEqual({ spec: 'cubicecho.agent/2', id: 'a' });
  });

  it("keeps a prompt the form can't show as it was", () => {
    const withMode = {
      ...DOCUMENT,
      prompt: [{ role: 'system', name: 'identity', mode: 'extend', content: 'And careful.' }],
    };
    expect(isPromptEditable(withMode)).toBe(false);
    expect(formValuesOf(withMode).prompt).toEqual([]);
    expect(documentFrom(withMode, formValuesOf(withMode)).prompt).toEqual(withMode.prompt);
  });

  it('writes the modes apps may use, leaving out the default, and the layout, leaving out plain', () => {
    const values = formValuesOf(DOCUMENT);
    const [identity] = values.prompt;
    if (identity === undefined) {
      throw new Error('The document has an identity part.');
    }
    const changed = documentFrom(DOCUMENT, {
      ...values,
      prompt: [{ ...identity, appsReplace: true }],
      promptLayout: 'plain',
    });
    expect(changed.prompt).toEqual([
      { role: 'system', name: 'identity', content: 'You help with money.', allowedModes: ['extend', 'replace'] },
    ]);
    expect(changed).not.toHaveProperty('promptLayout');
  });
});
