import { AGENT_SPEC, createRuntime, type RunEvent, type RunEventInput, RunEventKind } from '@cubicecho/agent-core';
import { resolveAgentSpec } from '@cubicecho/agent-core/spec';
import { describe, expect, it } from 'vitest';
import { HttpStatus, MODELS_BASE_URL } from '../../server/core/wire.ts';
import {
  type RunAssignment,
  type RunPorts,
  TOOL_ORIGIN_ROUTER,
  type ToolCallOptions,
} from '../../server/runner/assignment.ts';
import { executeRun } from '../../server/runner/execute.ts';

/** The router tool, as the model calls it. */
const ECHO = 'fix_ture__echo';
/** The app's tool, which the run hands back. */
const ASK = 'ask_user';
/** Where the loop asks the model for a turn. */
const COMPLETIONS_PATH = '/chat/completions';

/** One tool call the fake model makes. */
interface ModelCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * Writes one answer as an OpenAI chat completion stream.
 *
 * @param reply - A tool call, or the text the model says.
 * @returns The response.
 */
function streamed(reply: ModelCall | string): Response {
  const chunk = (body: Record<string, unknown>) =>
    `data: ${JSON.stringify({ id: 'up', object: 'chat.completion.chunk', created: 0, model: 'm1', ...body })}\n\n`;
  const choice = (delta: Record<string, unknown>, finish: string | null) =>
    chunk({ choices: [{ index: 0, delta, finish_reason: finish }] });
  const isText = typeof reply === 'string';
  const parts = isText
    ? [choice({ role: 'assistant', content: reply }, null), choice({}, 'stop')]
    : [
        choice(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: reply.id,
                type: 'function',
                function: { name: reply.name, arguments: JSON.stringify(reply.args) },
              },
            ],
          },
          null,
        ),
        choice({}, 'tool_calls'),
      ];
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const body = [...parts, chunk({ choices: [], usage }), 'data: [DONE]\n\n'].join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/**
 * Builds a stretch that reaches the echo tool and hands `ask_user` back.
 *
 * @returns The assignment.
 */
function assignment(): RunAssignment {
  const config = resolveAgentSpec([
    { spec: AGENT_SPEC, endpoint: { baseUrl: MODELS_BASE_URL }, model: { model: 'fake/m1' } },
  ]);
  return {
    runId: 'run-1',
    config,
    prompt: [],
    messages: [{ role: 'user', content: 'hello' }],
    loaded: [],
    tools: [{ type: 'function', function: { name: ECHO, description: 'Echoes.', parameters: { type: 'object' } } }],
    catalog: [{ id: 'fix.ture', label: 'fix.ture', tools: [{ name: ECHO, description: 'Echoes.' }] }],
    targets: { [ECHO]: { origin: TOOL_ORIGIN_ROUTER, server: 'server-1', tool: 'echo' } },
    appTools: [{ type: 'function', function: { name: ASK, parameters: { type: 'object' } } }],
  };
}

/** What the fake router heard from a stretch. */
interface Heard {
  ports: RunPorts;
  events: RunEventInput[];
  calls: { server: string; tool: string; args: Record<string, unknown>; call: ToolCallOptions['call'] }[];
  modelUrls: string[];
}

/**
 * Builds the router's side of a stretch, with a fake model.
 *
 * @param replies - What the model answers each request with, in order.
 * @returns The ports, and what they heard.
 */
function fakeRouter(replies: (ModelCall | string)[]): Heard {
  const events: RunEventInput[] = [];
  const calls: Heard['calls'] = [];
  const modelUrls: string[] = [];
  const queue = [...replies];
  const ports: RunPorts = {
    modelFetch: async (url) => {
      modelUrls.push(String(url));
      const isCompletion = String(url).endsWith(COMPLETIONS_PATH);
      if (isCompletion === false) {
        // What the loop asks of a server besides completions, such as its context length, it does without.
        return new Response('not found', { status: HttpStatus.NotFound });
      }
      const reply = queue.shift();
      if (reply === undefined) {
        throw new Error('The fake model has nothing more to say.');
      }
      return streamed(reply);
    },
    callRouterTool: async (server, tool, args, { call }) => {
      calls.push({ server, tool, args, call });
      return `echoed ${String(args.text)}`;
    },
    publish: (event): RunEvent => {
      events.push(event);
      return {
        at: 0,
        text: '',
        name: '',
        exchange: '',
        ok: null,
        usage: null,
        ...event,
        runId: 'run-1',
        seq: events.length,
      };
    },
    signal: new AbortController().signal,
  };
  return { ports, events, calls, modelUrls };
}

describe('executing a run', () => {
  it("calls a router tool through its port, and hands an app tool back without publishing the stand-in's result", async () => {
    const heard = fakeRouter([
      { id: 'call_a', name: ECHO, args: { text: 'hi' } },
      { id: 'call_b', name: ASK, args: { question: 'which?' } },
    ]);
    const outcome = await executeRun(assignment(), heard.ports, createRuntime());

    expect(outcome).toMatchObject({ ok: true, handedBack: ['call_b'] });
    expect(heard.calls).toEqual([
      { server: 'server-1', tool: 'echo', args: { text: 'hi' }, call: { id: 'call_a', name: ECHO } },
    ]);
    const turns = heard.modelUrls.filter((url) => url.endsWith(COMPLETIONS_PATH));
    expect(turns).toEqual([`${MODELS_BASE_URL}${COMPLETIONS_PATH}`, `${MODELS_BASE_URL}${COMPLETIONS_PATH}`]);
    const toolEvents = heard.events
      .filter((event) => event.kind === RunEventKind.ToolCall || event.kind === RunEventKind.ToolResult)
      .map((event) => [event.kind, event.id]);
    expect(toolEvents).toEqual([
      [RunEventKind.ToolCall, 'call_a'],
      [RunEventKind.ToolResult, 'call_a'],
      [RunEventKind.ToolCall, 'call_b'],
    ]);
  });

  it('answers a failure as a failed outcome, never a rejection', async () => {
    const heard = fakeRouter([]);
    const outcome = await executeRun(assignment(), heard.ports, createRuntime());
    expect(outcome).toMatchObject({ ok: false, error: expect.any(String) });
  });
});
