import { describe, expect, it } from 'vitest';
import { documentFrom, formValuesOf, isPromptEditable, ServerReach } from '../../web/agents/agent-form.ts';

/** A document with something in every part the form shows, and parts it doesn't. */
const DOCUMENT = {
  spec: 'cubicecho.agent/1',
  id: 'personal-finance',
  name: 'Personal finance',
  description: 'Answers from the budget.',
  endpoint: { requestTimeoutSeconds: 30 },
  model: { model: 'ollama/qwen3:32b', temperature: 0, maxTokens: 2048, extraBody: { top_k: 20 } },
  prompt: [
    { id: 'identity', text: 'You help with money.' },
    { id: 'rules', text: 'Only from the documents.' },
  ],
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
      prompt: DOCUMENT.prompt,
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
    expect(formValuesOf({ spec: 'cubicecho.agent/1' })).toMatchObject({
      id: '',
      model: '',
      temperature: null,
      prompt: [],
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
    const bare = { spec: 'cubicecho.agent/1', id: 'a', model: { model: 'p/m' }, tools: { maxIterations: 3 } };
    const emptied = documentFrom(bare, {
      ...formValuesOf(bare),
      model: '',
      maxIterations: null,
      serverReach: ServerReach.Every,
    });
    expect(emptied).toEqual({ spec: 'cubicecho.agent/1', id: 'a' });
  });

  it("keeps a prompt the form can't show as it was", () => {
    const withRef = { ...DOCUMENT, prompt: [{ id: 'identity', ref: { type: 'file', value: 'soul.md' } }] };
    expect(isPromptEditable(withRef)).toBe(false);
    expect(formValuesOf(withRef).prompt).toEqual([]);
    expect(documentFrom(withRef, formValuesOf(withRef)).prompt).toEqual(withRef.prompt);
  });
});
