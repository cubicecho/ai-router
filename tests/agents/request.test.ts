import { AGENT_SPEC, type AgentSpec } from '@cubicecho/agent-core/spec';
import { describe, expect, it } from 'vitest';
import { resolveRun, withRouterFetch } from '../../server/agents/layers.ts';
import { RequestRefusal, readRunRequest } from '../../server/agents/request.ts';
import { ROUTER_DEFAULTS, type RouterSettings } from '../../server/core/defaults.ts';
import { UnlistedFields } from '../../server/core/settings.ts';
import { EMPTY_SNAPSHOT, type Snapshot, type SnapshotServer } from '../../server/db/snapshot.ts';
import { MODELS_BASE_URL } from '../../server/models/forward.ts';
import { TRANSPORT_STDIO } from '../../server/tools/shapes.ts';

const QUESTION = { role: 'user', content: 'How much is left for groceries?' };
/** The router set to drop the stream_options keys it doesn't read. */
const IGNORING: RouterSettings = { ...ROUTER_DEFAULTS, unlistedFields: UnlistedFields.Ignore };

/** The agent the layers are stacked on. */
const AGENT: AgentSpec = {
  spec: AGENT_SPEC,
  id: 'personal-finance',
  model: { model: 'ollama/qwen3:32b', temperature: 0.3, extraBody: { top_k: 20 } },
  prompt: [
    { role: 'system', name: 'role', content: 'You help me run my household money.' },
    { role: 'system', name: 'format', content: 'Answer in a short table.', allowedModes: ['replace'] },
  ],
  tools: { servers: ['actual', 'finance-docs'] },
  tasks: { title: { model: 'ollama/qwen3:0.6b' } },
};

/** The servers the run's workspace granted the agent. */
const GRANTED = ['actual', 'finance-docs'];

/**
 * Builds a server entry for the snapshot.
 *
 * @param name - Its name.
 * @param [enabled] - Whether it is on.
 * @returns The server.
 */
function server(name: string, enabled = true): SnapshotServer {
  return {
    id: `id-${name}`,
    name,
    enabled,
    transport: { type: TRANSPORT_STDIO, command: 'node', args: [] },
    env: {},
    headers: {},
    childUid: 10_000,
    installDir: null,
    extraGroups: [],
    idleTimeoutMs: null,
    callTimeoutMs: null,
    signedIn: false,
    oauth: null,
    entries: new Map(),
  };
}

const SNAPSHOT: Snapshot = {
  ...EMPTY_SNAPSHOT,
  servers: new Map([
    ['actual', server('actual')],
    ['finance-docs', server('finance-docs')],
    ['github', server('github')],
  ]),
};

/**
 * Reads a request and expects it refused.
 *
 * @param body - The body.
 * @param [settings] - The router's settings.
 * @returns The refusal.
 */
function refusalOf(body: unknown, settings: RouterSettings = ROUTER_DEFAULTS): RequestRefusal {
  try {
    readRunRequest(body, settings);
  } catch (error) {
    if (error instanceof RequestRefusal) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected a refusal.');
}

describe('reading a request', () => {
  it('maps temperature, the ceiling and reasoning_effort by name, and only the rest into extraBody', () => {
    const request = readRunRequest(
      {
        model: 'x',
        messages: [QUESTION],
        temperature: 0.9,
        max_tokens: 400,
        reasoning_effort: 'low',
        top_p: 0.5,
        seed: 7,
        stop: ['END'],
      },
      ROUTER_DEFAULTS,
    );
    expect(request.sampling).toEqual({
      temperature: 0.9,
      maxTokens: 400,
      reasoningEffort: 'low',
      extraBody: { top_p: 0.5, seed: 7, stop: ['END'] },
    });
  });

  it('passes every field the router does not read to the model, whatever the settings say', () => {
    const body = {
      model: 'x',
      messages: [QUESTION],
      temperature: 0.4,
      metadata: { app: 'task_server' },
      store: false,
      logit_bias: { 1: 2 },
      top_p: 0.9,
      logprobs: null,
    };
    const extraBody = { metadata: { app: 'task_server' }, store: false, logit_bias: { 1: 2 }, top_p: 0.9 };
    for (const settings of [ROUTER_DEFAULTS, IGNORING]) {
      const request = readRunRequest(body, settings);
      expect(request.ignored).toEqual([]);
      expect(request.sampling).toEqual({ temperature: 0.4, extraBody });
    }
  });

  it('drops unknown stream_options keys when the settings ignore them, keeping include_usage', () => {
    const body = {
      model: 'x',
      messages: [QUESTION],
      stream: true,
      stream_options: { include_obfuscation: false, include_usage: true, chunk_size: null },
    };
    const refusal = refusalOf(body);
    expect(refusal.param).toBe('stream_options');
    expect(refusal.message).toContain('include_obfuscation');
    const request = readRunRequest(body, IGNORING);
    expect(request.ignored).toEqual(['stream_options.include_obfuscation']);
    expect(request.includeUsage).toBe(true);
    const withField = { ...body, metadata: { app: 'a' } };
    expect(readRunRequest(withField, IGNORING).ignored).toEqual(['stream_options.include_obfuscation']);
    // A bad include_usage, or stream_options that aren't an object, are refused either way.
    const ask = (streamOptions: unknown) => refusalOf({ ...body, stream_options: streamOptions }, IGNORING).param;
    expect(ask({ include_usage: 'yes' })).toBe('stream_options');
    expect(ask('usage')).toBe('stream_options');
  });

  it('still refuses structural problems and bad values of the fields it reads when the settings ignore stream options', () => {
    const ask = (extra: Record<string, unknown>) =>
      refusalOf({ model: 'x', messages: [QUESTION], ...extra }, IGNORING).param;
    expect(ask({ n: 2 })).toBe('n');
    expect(ask({ temperature: 3 })).toBe('temperature');
    expect(ask({ max_tokens: 0 })).toBe('max_tokens');
    expect(ask({ tool_choice: 'required' })).toBe('tool_choice');
    expect(ask({ functions: [{ name: 'f' }] })).toBe('functions');
    expect(ask({ agent_core: { tools: true } })).toBe('agent_core');
    expect(ask({ agent_core: { prompt: [{ name: 'lane' }] } })).toBe('agent_core.prompt');
    expect(ask({ ai_router: { progress: true } })).toBe('ai_router');
    expect(ask({ response_format: 'json' })).toBe('response_format');
    expect(ask({ reasoning_effort: 2 })).toBe('reasoning_effort');
    expect(ask({ messages: [{ role: 'robot', content: 'Hi.' }] })).toBe('messages');
    const tools = ['a', 'b'].map((name) => ({ type: 'function', function: { name } }));
    expect(refusalOf({ model: 'x', messages: [QUESTION], tools }, { ...IGNORING, maxAppTools: 1 }).param).toBe('tools');
  });

  it('refuses n above 1', () => {
    expect(refusalOf({ model: 'x', messages: [QUESTION], n: 2 }).param).toBe('n');
    expect(readRunRequest({ model: 'x', messages: [QUESTION], n: 1 }, ROUTER_DEFAULTS).stream).toBe(false);
  });

  it("reads the app's tools, and refuses legacy functions, a forced tool_choice, a bad or repeated name", () => {
    const tools = [{ type: 'function', function: { name: 'ask_user', parameters: { type: 'object' }, strict: null } }];
    const request = readRunRequest({ model: 'x', messages: [QUESTION], tools, tool_choice: 'auto' }, ROUTER_DEFAULTS);
    expect(request.appTools).toEqual([
      { type: 'function', function: { name: 'ask_user', parameters: { type: 'object' } } },
    ]);
    expect(refusalOf({ model: 'x', messages: [QUESTION], tool_choice: 'none' }).param).toBe('tool_choice');
    expect(refusalOf({ model: 'x', messages: [QUESTION], functions: [] }).param).toBe('functions');
    expect(refusalOf({ model: 'x', messages: [QUESTION], tools: [...tools, ...tools] }).param).toBe('tools.1');
    const badName = [{ type: 'function', function: { name: 'ask.user' } }];
    expect(refusalOf({ model: 'x', messages: [QUESTION], tools: badName }).param).toBe('tools');
    const loops = [{ type: 'function', function: { name: 'call_tool' } }];
    expect(refusalOf({ model: 'x', messages: [QUESTION], tools: loops }).param).toBe('tools.0');
  });

  it("refuses more app tools than the router's settings allow", () => {
    const tools = ['a', 'b', 'c'].map((name) => ({ type: 'function', function: { name } }));
    const body = { model: 'x', messages: [QUESTION], tools };
    expect(readRunRequest(body, { ...ROUTER_DEFAULTS, maxAppTools: 3 }).appTools).toHaveLength(3);
    expect(() => readRunRequest(body, { ...ROUTER_DEFAULTS, maxAppTools: 2 })).toThrow(
      'tools: send at most 2 with one request.',
    );
  });

  it('keeps tool history, and reads the tool messages at the end as answers', () => {
    const history = [
      QUESTION,
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'done' },
    ];
    const answered = readRunRequest({ model: 'x', messages: history }, ROUTER_DEFAULTS);
    expect(answered.messages).toHaveLength(3);
    expect(answered.answers).toEqual([{ callId: 'c1', content: 'done' }]);
    const goneOn = readRunRequest({ model: 'x', messages: [...history, QUESTION] }, ROUTER_DEFAULTS);
    expect(goneOn.answers).toEqual([]);
  });

  it('keeps as input the system messages and the new turn, or for a resume only the answers', () => {
    const host = { role: 'system', content: 'You are in task_server.' };
    const said = { role: 'assistant', content: 'About 40.' };
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const next = { role: 'user', content: [{ type: 'text', text: 'And this receipt?' }, image] };
    const request = readRunRequest({ model: 'x', messages: [host, QUESTION, said, next] }, ROUTER_DEFAULTS);
    expect(request.input).toEqual([
      { role: 'system', content: 'You are in task_server.' },
      { role: 'user', content: 'And this receipt?', images: 1 },
    ]);
    const first = readRunRequest({ model: 'x', messages: [host, QUESTION] }, ROUTER_DEFAULTS);
    expect(first.input).toEqual([host, QUESTION]);
    const call = { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } };
    const handedBack = { role: 'assistant', content: null, tool_calls: [call] };
    const answer = { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'done' }] };
    const resume = readRunRequest({ model: 'x', messages: [host, QUESTION, handedBack, answer] }, ROUTER_DEFAULTS);
    expect(resume.input).toEqual([{ role: 'tool', content: 'done', toolCallId: 'c1' }]);
  });

  it('passes response_format and parallel_tool_calls to the model, and records user', () => {
    const body = {
      model: 'x',
      messages: [QUESTION],
      response_format: { type: 'json_object' },
      parallel_tool_calls: false,
      user: 'household-a',
    };
    const request = readRunRequest(body, ROUTER_DEFAULTS);
    expect(request.sampling.extraBody).toEqual({
      response_format: { type: 'json_object' },
      parallel_tool_calls: false,
    });
    expect(request.user).toBe('household-a');
  });

  it('turns the leading system and developer messages into one text, and keeps later ones in the conversation', () => {
    const request = readRunRequest(
      {
        model: 'x',
        messages: [
          { role: 'system', content: 'You are in task_server.' },
          { role: 'developer', content: [{ type: 'text', text: 'Be brief.' }] },
          QUESTION,
          { role: 'system', content: 'A later note.' },
        ],
        agent_core: { prompt: [{ role: 'system', name: 'lane', content: 'The Review lane.' }], progress: true },
      },
      ROUTER_DEFAULTS,
    );
    expect(request.systemText).toBe('You are in task_server.\n\nBe brief.');
    expect(request.appParts).toEqual([{ role: 'system', name: 'lane', content: 'The Review lane.' }]);
    expect(request.progress).toBe(true);
    expect(request.messages).toEqual([QUESTION, { role: 'system', content: 'A later note.' }]);
  });

  it('takes system messages, app parts and a narrowing of the servers', () => {
    const lane = { role: 'system', name: 'lane', content: 'The Review lane.' };
    const withBoth = {
      model: 'x',
      messages: [{ role: 'system', content: 'Hi.' }, QUESTION],
      agent_core: { prompt: [lane] },
    };
    expect(readRunRequest(withBoth, ROUTER_DEFAULTS)).toMatchObject({ systemText: 'Hi.', appParts: [lane] });
    const narrowed = readRunRequest({ model: 'x', messages: [QUESTION], agent_core: { servers: [] } }, ROUTER_DEFAULTS);
    expect(narrowed.servers).toEqual([]);
    expect(refusalOf({ model: 'x', messages: [QUESTION], agent_core: { tools: true } }).param).toBe('agent_core');
  });

  it('refuses ai_router, the old name of agent_core, and app parts agent-core cannot read', () => {
    const old = refusalOf({ model: 'x', messages: [QUESTION], ai_router: { servers: [] } });
    expect(old.param).toBe('ai_router');
    expect(old.message).toContain('agent_core');
    const ask = (prompt: unknown) => refusalOf({ model: 'x', messages: [QUESTION], agent_core: { prompt } });
    expect(ask('be brief').message).toContain('agent_core.prompt');
    expect(ask([{ role: 'system', name: 'lane', content: 'x', allowedModes: [] }]).message).toContain('allowedModes');
    expect(ask([{ role: 'system', content: 'no name' }]).param).toBe('agent_core.prompt');
    expect(ask([{ role: 'system', name: 'lane', content: 'x', mode: 'overwrite' }]).param).toBe('agent_core.prompt');
  });

  it('refuses a conversation that is only system messages, and a temperature out of range', () => {
    expect(refusalOf({ model: 'x', messages: [{ role: 'system', content: 'Hi.' }] }).param).toBe('messages');
    expect(refusalOf({ model: 'x', messages: [QUESTION], temperature: 3 }).param).toBe('temperature');
    expect(refusalOf({ model: 'x', messages: [QUESTION], max_tokens: 10, max_completion_tokens: 20 }).param).toBe(
      'max_completion_tokens',
    );
  });
});

describe('stacking the layers', () => {
  it('puts the router underneath, the app parts and system messages after the agent, and the request on the main model only', () => {
    const request = readRunRequest(
      {
        model: 'personal-finance',
        messages: [{ role: 'system', content: 'You are in task_server.' }, QUESTION],
        agent_core: {
          prompt: [
            { role: 'system', name: 'role', mode: 'extend', content: 'Only the shared account.' },
            { role: 'system', name: 'format', mode: 'replace', content: 'Answer as JSON.' },
            { role: 'system', name: 'week', content: 'This is the Friday summary.' },
          ],
        },
        temperature: 0.9,
        min_p: 0.05,
      },
      ROUTER_DEFAULTS,
    );
    const { agent: resolved, prompt } = resolveRun(AGENT, GRANTED, request, SNAPSHOT);
    expect(resolved.baseUrl).toBe(MODELS_BASE_URL);
    expect(resolved.model).toBe('ollama/qwen3:32b');
    expect(prompt.parts.map(({ name, owner, mark }) => ({ name, owner, mark }))).toEqual([
      { name: 'role', owner: 'agent', mark: undefined },
      { name: 'format', owner: 'agent', mark: undefined },
      { name: 'app_role', owner: 'app', mark: { mode: 'extend', target: 'role' } },
      { name: 'app_format', owner: 'app', mark: { mode: 'replace', target: 'format' } },
      { name: 'app_week', owner: 'app', mark: undefined },
      { name: 'app_system', owner: 'app', mark: undefined },
    ]);
    expect(prompt.warnings).toEqual([]);
    expect(resolved.temperature).toBe(0.9);
    expect(resolved.extraBody).toEqual({ top_k: 20, min_p: 0.05 });
    expect(resolved.tasks.title).toMatchObject({ model: 'ollama/qwen3:0.6b', endpoint: { baseUrl: MODELS_BASE_URL } });
    expect(resolved.tasks.title?.temperature).toBeUndefined();
    expect(resolved.tasks.title?.extraBody).toBeUndefined();
    expect(resolved.servers).toEqual(['actual', 'finance-docs']);
  });

  it("drops an app part that uses a mode the agent's part doesn't allow, and the name system, with a warning each", () => {
    const request = readRunRequest(
      {
        model: 'personal-finance',
        messages: [QUESTION],
        agent_core: {
          prompt: [
            { role: 'system', name: 'role', mode: 'replace', content: 'You help anyone.' },
            { role: 'system', name: 'format', mode: 'extend', content: 'And a chart.' },
            { role: 'system', name: 'system', content: 'Mine.' },
          ],
        },
      },
      ROUTER_DEFAULTS,
    );
    const { prompt } = resolveRun(AGENT, GRANTED, request, SNAPSHOT);
    expect(prompt.parts.map((part) => part.name)).toEqual(['role', 'format']);
    expect(prompt.warnings.map(({ part, rule }) => ({ part, rule }))).toEqual([
      { part: 'role', rule: 'replace-not-allowed' },
      { part: 'format', rule: 'extend-not-allowed' },
      { part: 'system', rule: 'reserved-name' },
    ]);
  });

  it('reaches the servers its workspace granted, never the ones its document names', () => {
    const plain = readRunRequest({ model: 'x', messages: [QUESTION] }, ROUTER_DEFAULTS);
    const namesGithub: AgentSpec = { ...AGENT, tools: { servers: ['github'] } };
    expect(resolveRun(namesGithub, ['actual'], plain, SNAPSHOT).agent.servers).toEqual(['actual']);
    const namesNone: AgentSpec = { ...AGENT, tools: {} };
    expect(resolveRun(namesNone, ['actual'], plain, SNAPSHOT).agent.servers).toEqual(['actual']);
    expect(resolveRun(AGENT, [], plain, SNAPSHOT).agent.servers).toEqual([]);
  });

  it('narrows the granted servers to those the request names, and never widens them', () => {
    const narrowed = readRunRequest(
      { model: 'x', messages: [QUESTION], agent_core: { servers: ['finance-docs', 'github'] } },
      ROUTER_DEFAULTS,
    );
    expect(resolveRun(AGENT, GRANTED, narrowed, SNAPSHOT).agent.servers).toEqual(['finance-docs']);
    const none = readRunRequest(
      { model: 'x', messages: [QUESTION], agent_core: { servers: ['github'] } },
      ROUTER_DEFAULTS,
    );
    expect(resolveRun(AGENT, GRANTED, none, SNAPSHOT).agent.servers).toEqual([]);
    expect(resolveRun(AGENT, [], narrowed, SNAPSHOT).agent.servers).toEqual([]);
  });

  it("gives the run's fetch to the router's endpoints only, and leaves an agent's own endpoint alone", () => {
    const plain = readRunRequest({ model: 'x', messages: [QUESTION] }, ROUTER_DEFAULTS);
    const fetch: typeof globalThis.fetch = async () => new Response(null);
    const config = withRouterFetch(resolveRun(AGENT, GRANTED, plain, SNAPSHOT).agent, fetch);
    expect(config.fetch).toBe(fetch);
    expect(config.tasks.title?.endpoint.fetch).toBe(fetch);
    const ownEndpoint: AgentSpec = {
      ...AGENT,
      endpoint: { baseUrl: 'http://gpu:8080/v1' },
      tasks: { title: { model: 'small', endpoint: { baseUrl: MODELS_BASE_URL } } },
    };
    const own = withRouterFetch(resolveRun(ownEndpoint, GRANTED, plain, SNAPSHOT).agent, fetch);
    expect(own.baseUrl).toBe('http://gpu:8080/v1');
    expect(own.fetch).toBeUndefined();
    expect(own.apiKey).toBe('');
    expect(own.tasks.title?.endpoint.fetch).toBe(fetch);
  });
});
