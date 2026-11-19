import { describe, expect, it } from 'vitest';
import { type AgentToolShape, pruneAppTools } from '../../server/agents/app-tools.ts';
import type { AppTool } from '../../server/agents/request.ts';

/** The input schema of `create_issue` on both servers. */
const ISSUE_SCHEMA = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] };

/** The agent's tools, by the function name its model sees. */
const AGENT_TOOLS = new Map<string, AgentToolShape>([
  [
    'github__create_issue',
    { serverId: 'id-github', serverName: 'github', tool: 'create_issue', parameters: ISSUE_SCHEMA },
  ],
  ['llama_cpp__read_file', { serverId: 'id-llama', serverName: 'llama.cpp', tool: 'read.file', parameters: {} }],
]);

/**
 * Builds an app tool.
 *
 * @param name - Its name.
 * @param [parameters] - Its input schema.
 * @returns The tool, as a request sends it.
 */
const appTool = (name: string, parameters?: Record<string, unknown>): AppTool => ({
  type: 'function',
  function: { name, ...(parameters === undefined ? {} : { parameters }) },
});

describe('pruning app tools', () => {
  it("always leaves out one with the name of an agent's tool, and keeps the rest in order", () => {
    const sent = [appTool('ask_user'), appTool('github__create_issue'), appTool('pick_date')];
    const { kept, pruned } = pruneAppTools(sent, AGENT_TOOLS, false);
    expect(kept.map((tool) => tool.function.name)).toEqual(['ask_user', 'pick_date']);
    expect(pruned).toEqual([{ name: 'github__create_issue', agentTool: 'github__create_issue', acrossServers: false }]);
  });

  it('keeps the same tool under another server name unless pruning across servers is on', () => {
    const sent = [appTool('gh__create_issue', ISSUE_SCHEMA)];
    expect(pruneAppTools(sent, AGENT_TOOLS, false)).toEqual({ kept: sent, pruned: [] });
    expect(pruneAppTools(sent, AGENT_TOOLS, true)).toEqual({
      kept: [],
      pruned: [{ name: 'gh__create_issue', agentTool: 'github__create_issue', acrossServers: true }],
    });
  });

  it('compares the schemas by value, whatever order their keys are in', () => {
    const reordered = { required: ['title'], properties: { title: { type: 'string' } }, type: 'object' };
    expect(pruneAppTools([appTool('gh__create_issue', reordered)], AGENT_TOOLS, true).kept).toEqual([]);
  });

  it('keeps a tool whose schema, or whose name after __, differs, and one with no __', () => {
    const sent = [
      appTool('gh__create_issue', { ...ISSUE_SCHEMA, required: [] }),
      appTool('gh__create_issue_comment', ISSUE_SCHEMA),
      appTool('gh__create_issue'),
      appTool('create_issue', ISSUE_SCHEMA),
    ];
    expect(pruneAppTools(sent, AGENT_TOOLS, true)).toEqual({ kept: sent, pruned: [] });
  });

  it("matches a tool's own name as the model sees it, with OpenAI's characters", () => {
    const { pruned } = pruneAppTools([appTool('llama__read_file', {})], AGENT_TOOLS, true);
    expect(pruned).toEqual([{ name: 'llama__read_file', agentTool: 'llama_cpp__read_file', acrossServers: true }]);
  });
});
