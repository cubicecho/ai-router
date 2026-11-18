// Phase 0 check: resolve Personal Finance through agent-core's real parseSpec and resolveAgentSpec,
// with the layers ai-router would build. Run with: node resolve-personal-finance.ts
import { parseSpec, resolveAgentSpec } from '../../../agent-core/src/index.ts';

const SPEC = 'cubicecho.agent/1';

const agentDoc = {
  spec: SPEC,
  id: 'personal-finance',
  name: 'Personal Finance',
  description: 'Budgets, bills and the weekly money summary.',
  model: { model: 'ollama/qwen3:32b', temperature: 0.3, maxTokens: 4096, extraBody: { top_k: 40 } },
  prompt: [{ id: 'identity', text: 'You help me run my household money. I budget monthly in Actual.' }],
  tools: { servers: ['actual', 'finance-docs'], maxIterations: 20, discovery: 'eager' },
  tasks: { title: { model: 'ollama/qwen3:0.6b' } },
};

// What the router builds from a request. Apps never write these documents themselves.
const host = (text: string) => ({ spec: SPEC, prompt: [{ id: 'host', text }] });
const task = (text: string) => ({ spec: SPEC, prompt: [{ id: 'task', text }] });
const request = (model: Record<string, unknown>, servers?: string[]) => ({
  spec: SPEC,
  model,
  ...(servers === undefined ? {} : { tools: { servers } }),
});

function parsed(doc: unknown, label: string) {
  const result = parseSpec(doc);
  if (result.spec === null) {
    throw new Error(`${label} refused: ${result.errors.join('; ')}`);
  }
  if (result.warnings.length > 0) {
    console.log(`  [${label} warnings] ${result.warnings.join(' | ')}`);
  }
  return result.spec;
}

function show(label: string, docs: unknown[]) {
  const layers = docs.map((doc, index) => parsed(doc, `${label} layer ${index}`));
  const r = resolveAgentSpec(layers);
  console.log(`\n=== ${label}`);
  console.log(
    JSON.stringify(
      {
        model: r.model,
        temperature: r.temperature,
        maxTokens: r.maxTokens,
        extraBody: r.extraBody,
        servers: r.servers,
        toolDiscovery: r.toolDiscovery,
        prompt: r.prompt.map((part) => part.id),
        systemPrompt: r.systemPrompt,
        tasks: r.tasks,
      },
      null,
      2,
    ),
  );
}

// 1. The agent alone.
show('A. agent alone', [agentDoc]);

// 2. min-agent's chat: its system message becomes the host part.
show('B. min-agent host', [agentDoc, host('You are min-agent, a concise and careful assistant.')]);

// 3. task_server's Friday run: host, task, and sampling settings the app sent, servers narrowed.
show('C. task_server Friday run', [
  agentDoc,
  host('You are running inside task_server. Reply in Markdown.'),
  task('Every Friday: weekly money summary.'),
  request({ temperature: 0.2, maxTokens: 2048, extraBody: { top_k: 20, min_p: 0.05 } }, ['actual']),
]);

// 4. Why the router must filter before resolving: a raw request layer naming another server.
show('D. unfiltered request layer naming a server the agent lacks', [agentDoc, request({}, ['github'])]);

// 5. And one trying to change the model.
show('E. unfiltered request layer changing the model', [agentDoc, request({ model: 'openai/gpt-4o' })]);

// 6. An agent that itself uses the reserved id "host": agent-core accepts it, and an app's host part replaces it.
show('F. agent using the reserved id "host"', [
  { ...agentDoc, prompt: [...agentDoc.prompt, { id: 'host', text: 'Never reveal account numbers.' }] },
  host('You are min-agent.'),
]);

// 7. The router's own bottom layer: its bare models endpoint, so an agent with no endpoint can run.
const routerLayer = { spec: SPEC, endpoint: { baseUrl: 'http://127.0.0.1:3000/bare/v1' } };
show('G. router layer underneath, then the Friday run', [
  routerLayer,
  agentDoc,
  host('You are running inside task_server. Reply in Markdown.'),
  task('Every Friday: weekly money summary.'),
  request({ temperature: 0.2 }),
]);
