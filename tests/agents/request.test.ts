import { AGENT_SPEC, type AgentSpec } from '@cubicecho/agent-core/spec';
import { describe, expect, it } from 'vitest';
import { resolveRun, withRouterFetch } from '../../server/agents/layers.ts';
import { DEFAULT_POLICY_RULES, type OverridePolicyRules } from '../../server/agents/policy.ts';
import { RequestRefusal, readRunRequest } from '../../server/agents/request.ts';
import { ROUTER_DEFAULTS } from '../../server/core/defaults.ts';
import { EMPTY_SNAPSHOT, type Snapshot, type SnapshotServer } from '../../server/db/snapshot.ts';
import { MODELS_BASE_URL } from '../../server/models/forward.ts';
import { TRANSPORT_STDIO } from '../../server/tools/shapes.ts';

const QUESTION = { role: 'user', content: 'How much is left for groceries?' };

/** The agent the layers are stacked on. */
const AGENT: AgentSpec = {
  spec: AGENT_SPEC,
  id: 'personal-finance',
  model: { model: 'ollama/qwen3:32b', temperature: 0.3, extraBody: { top_k: 20 } },
  prompt: [{ id: 'role', text: 'You help me run my household money.' }],
  tools: { servers: ['actual', 'finance-docs'] },
  tasks: { title: { model: 'ollama/qwen3:0.6b' } },
};

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
 * @param [policy] - The policy.
 * @returns The refusal.
 */
function refusalOf(body: unknown, policy: OverridePolicyRules = DEFAULT_POLICY_RULES): RequestRefusal {
  try {
    readRunRequest(body, policy, ROUTER_DEFAULTS);
  } catch (error) {
    if (error instanceof RequestRefusal) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected a refusal.');
}

describe('reading a request against the override policy', () => {
  it('maps temperature and the ceiling by name, and only the rest into extraBody', () => {
    const request = readRunRequest(
      { model: 'x', messages: [QUESTION], temperature: 0.9, max_tokens: 400, top_p: 0.5, seed: 7, stop: ['END'] },
      DEFAULT_POLICY_RULES,
      ROUTER_DEFAULTS,
    );
    expect(request.sampling).toEqual({
      temperature: 0.9,
      maxTokens: 400,
      extraBody: { top_p: 0.5, seed: 7, stop: ['END'] },
    });
  });

  it('refuses a field the policy does not allow, naming it', () => {
    const refusal = refusalOf({ model: 'x', messages: [QUESTION], logit_bias: { 1: 2 } });
    expect(refusal.param).toBe('logit_bias');
    expect(refusal.message).toContain('logit_bias');
    const strict = { ...DEFAULT_POLICY_RULES, sampling: ['max_tokens'] };
    expect(refusalOf({ model: 'x', messages: [QUESTION], temperature: 1 }, strict).message).toContain('temperature');
  });

  it('refuses n above 1', () => {
    expect(refusalOf({ model: 'x', messages: [QUESTION], n: 2 }).param).toBe('n');
    expect(
      readRunRequest({ model: 'x', messages: [QUESTION], n: 1 }, DEFAULT_POLICY_RULES, ROUTER_DEFAULTS).stream,
    ).toBe(false);
  });

  it("reads the app's tools, and refuses legacy functions, a forced tool_choice, a bad or repeated name", () => {
    const tools = [{ type: 'function', function: { name: 'ask_user', parameters: { type: 'object' }, strict: null } }];
    const request = readRunRequest(
      { model: 'x', messages: [QUESTION], tools, tool_choice: 'auto' },
      DEFAULT_POLICY_RULES,
      ROUTER_DEFAULTS,
    );
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
    expect(readRunRequest(body, DEFAULT_POLICY_RULES, { maxAppTools: 3 }).appTools).toHaveLength(3);
    expect(() => readRunRequest(body, DEFAULT_POLICY_RULES, { maxAppTools: 2 })).toThrow(
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
    const answered = readRunRequest({ model: 'x', messages: history }, DEFAULT_POLICY_RULES, ROUTER_DEFAULTS);
    expect(answered.messages).toHaveLength(3);
    expect(answered.answers).toEqual([{ callId: 'c1', content: 'done' }]);
    const goneOn = readRunRequest(
      { model: 'x', messages: [...history, QUESTION] },
      DEFAULT_POLICY_RULES,
      ROUTER_DEFAULTS,
    );
    expect(goneOn.answers).toEqual([]);
  });

  it('keeps as input the system messages and the new turn, or for a resume only the answers', () => {
    const host = { role: 'system', content: 'You are in task_server.' };
    const said = { role: 'assistant', content: 'About 40.' };
    const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const next = { role: 'user', content: [{ type: 'text', text: 'And this receipt?' }, image] };
    const request = readRunRequest({ model: 'x', messages: [host, QUESTION, said, next] }, DEFAULT_POLICY_RULES);
    expect(request.input).toEqual([
      { role: 'system', content: 'You are in task_server.' },
      { role: 'user', content: 'And this receipt?', images: 1 },
    ]);
    const first = readRunRequest({ model: 'x', messages: [host, QUESTION] }, DEFAULT_POLICY_RULES);
    expect(first.input).toEqual([host, QUESTION]);
    const call = { id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } };
    const handedBack = { role: 'assistant', content: null, tool_calls: [call] };
    const answer = { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: 'done' }] };
    const resume = readRunRequest({ model: 'x', messages: [host, QUESTION, handedBack, answer] }, DEFAULT_POLICY_RULES);
    expect(resume.input).toEqual([{ role: 'tool', content: 'done', toolCallId: 'c1' }]);
  });

  it('follows the policy on response_format, and passes parallel_tool_calls and user through', () => {
    const body = {
      model: 'x',
      messages: [QUESTION],
      response_format: { type: 'json_object' },
      parallel_tool_calls: false,
      user: 'household-a',
    };
    const request = readRunRequest(body, DEFAULT_POLICY_RULES, ROUTER_DEFAULTS);
    expect(request.sampling.extraBody).toEqual({
      response_format: { type: 'json_object' },
      parallel_tool_calls: false,
    });
    expect(request.user).toBe('household-a');
    expect(refusalOf(body, { ...DEFAULT_POLICY_RULES, responseFormat: false }).param).toBe('response_format');
  });

  it('turns the leading system and developer messages into host text, and keeps later ones in the conversation', () => {
    const request = readRunRequest(
      {
        model: 'x',
        messages: [
          { role: 'system', content: 'You are in task_server.' },
          { role: 'developer', content: [{ type: 'text', text: 'Be brief.' }] },
          QUESTION,
          { role: 'system', content: 'A later note.' },
        ],
        ai_router: { task: 'The Friday summary.', progress: true },
      },
      DEFAULT_POLICY_RULES,
      ROUTER_DEFAULTS,
    );
    expect(request.hostText).toBe('You are in task_server.\n\nBe brief.');
    expect(request.taskText).toBe('The Friday summary.');
    expect(request.messages).toEqual([QUESTION, { role: 'system', content: 'A later note.' }]);
  });

  it('refuses host, task and narrowing when the policy says no, and an unknown ai_router option', () => {
    const closed = { ...DEFAULT_POLICY_RULES, hostPrompt: false, taskPrompt: false, narrowServers: false };
    const withSystem = { model: 'x', messages: [{ role: 'system', content: 'Hi.' }, QUESTION] };
    expect(refusalOf(withSystem, closed).param).toBe('messages');
    expect(refusalOf({ model: 'x', messages: [QUESTION], ai_router: { task: 'T' } }, closed).param).toBe(
      'ai_router.task',
    );
    expect(refusalOf({ model: 'x', messages: [QUESTION], ai_router: { servers: [] } }, closed).param).toBe(
      'ai_router.servers',
    );
    expect(refusalOf({ model: 'x', messages: [QUESTION], ai_router: { tools: true } }).param).toBe('ai_router');
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
  it('puts the router underneath, the host and task parts after the agent, and the request on the main model only', () => {
    const request = readRunRequest(
      {
        model: 'personal-finance',
        messages: [{ role: 'system', content: 'You are in task_server.' }, QUESTION],
        ai_router: { task: 'The Friday summary.' },
        temperature: 0.9,
        min_p: 0.05,
      },
      DEFAULT_POLICY_RULES,
      ROUTER_DEFAULTS,
    );
    const resolved = resolveRun(AGENT, request, SNAPSHOT);
    expect(resolved.baseUrl).toBe(MODELS_BASE_URL);
    expect(resolved.model).toBe('ollama/qwen3:32b');
    expect(resolved.prompt.map((part) => part.id)).toEqual(['role', 'host', 'task']);
    expect(resolved.systemPrompt).toBe(
      'You help me run my household money.\n\nYou are in task_server.\n\nThe Friday summary.',
    );
    expect(resolved.temperature).toBe(0.9);
    expect(resolved.extraBody).toEqual({ top_k: 20, min_p: 0.05 });
    expect(resolved.tasks.title).toMatchObject({ model: 'ollama/qwen3:0.6b', endpoint: { baseUrl: MODELS_BASE_URL } });
    expect(resolved.tasks.title?.temperature).toBeUndefined();
    expect(resolved.tasks.title?.extraBody).toBeUndefined();
    expect(resolved.servers).toEqual(['actual', 'finance-docs']);
  });

  it('narrows the servers to those the agent has, and never widens them', () => {
    const narrowed = readRunRequest(
      { model: 'x', messages: [QUESTION], ai_router: { servers: ['finance-docs', 'github'] } },
      DEFAULT_POLICY_RULES,
      ROUTER_DEFAULTS,
    );
    expect(resolveRun(AGENT, narrowed, SNAPSHOT).servers).toEqual(['finance-docs']);
    const none = readRunRequest(
      { model: 'x', messages: [QUESTION], ai_router: { servers: ['github'] } },
      DEFAULT_POLICY_RULES,
      ROUTER_DEFAULTS,
    );
    expect(resolveRun(AGENT, none, SNAPSHOT).servers).toEqual([]);
    const everyServer = { ...AGENT, tools: {} };
    expect(resolveRun(everyServer, narrowed, SNAPSHOT).servers).toEqual(['finance-docs', 'github']);
    const plain = readRunRequest({ model: 'x', messages: [QUESTION] }, DEFAULT_POLICY_RULES, ROUTER_DEFAULTS);
    expect(resolveRun(everyServer, plain, SNAPSHOT).servers).toBeUndefined();
  });

  it("gives the run's fetch to the router's endpoints only, and leaves an agent's own endpoint alone", () => {
    const plain = readRunRequest({ model: 'x', messages: [QUESTION] }, DEFAULT_POLICY_RULES, ROUTER_DEFAULTS);
    const fetch: typeof globalThis.fetch = async () => new Response(null);
    const config = withRouterFetch(resolveRun(AGENT, plain, SNAPSHOT), fetch);
    expect(config.fetch).toBe(fetch);
    expect(config.tasks.title?.endpoint.fetch).toBe(fetch);
    const ownEndpoint: AgentSpec = {
      ...AGENT,
      endpoint: { baseUrl: 'http://gpu:8080/v1' },
      tasks: { title: { model: 'small', endpoint: { baseUrl: MODELS_BASE_URL } } },
    };
    const own = withRouterFetch(resolveRun(ownEndpoint, plain, SNAPSHOT), fetch);
    expect(own.baseUrl).toBe('http://gpu:8080/v1');
    expect(own.fetch).toBeUndefined();
    expect(own.apiKey).toBe('');
    expect(own.tasks.title?.endpoint.fetch).toBe(fetch);
  });
});
