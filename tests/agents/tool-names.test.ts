import { describe, expect, it } from 'vitest';
import { type RunTool, runToolNames } from '../../server/agents/tool-names.ts';

/** What OpenAI accepts as a function name. */
const FUNCTION_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Builds a tool on a server.
 *
 * @param serverName - The server.
 * @param tool - The tool's own name.
 * @returns The tool.
 */
const tool = (serverName: string, tool: string): RunTool => ({ serverId: `id-${serverName}`, serverName, tool });

describe('tool names a model accepts', () => {
  it('keeps <server>__<tool> when it is already valid', () => {
    const { names, dropped } = runToolNames([tool('actual', 'get_budget')]);
    expect([...names.keys()]).toEqual(['actual__get_budget']);
    expect(dropped).toEqual([]);
  });

  it('replaces characters a function name may not hold, and maps back to the server and tool', () => {
    const { names } = runToolNames([tool('llama.cpp', 'read.file')]);
    expect([...names]).toEqual([['llama_cpp__read_file', tool('llama.cpp', 'read.file')]]);
  });

  it('cuts a long name to 64 characters with a stable hash, the same every time', () => {
    const long = tool('a-server-with-quite-a-long-name', 'and_a_tool_whose_name_is_longer_still_than_that');
    const first = [...runToolNames([long]).names.keys()];
    const again = [...runToolNames([long]).names.keys()];
    expect(first).toEqual(again);
    const [name] = first;
    expect(name).toMatch(FUNCTION_NAME);
    expect(name).toHaveLength(64);
    const original = `${long.serverName}__${long.tool}`;
    expect(name?.slice(0, 55)).toBe(original.slice(0, 55));
    expect(name).toMatch(/_[0-9a-f]{8}$/);
  });

  it('tells apart two tools whose valid names collide, leaving an unchanged name as it was', () => {
    const changed = tool('my.server', 'x');
    const unchanged = tool('my_server', 'x');
    const { names, dropped } = runToolNames([changed, unchanged]);
    expect(dropped).toEqual([]);
    expect(names.get('my_server__x')).toEqual(unchanged);
    const [hashed] = [...names.keys()].filter((name) => name !== 'my_server__x');
    expect(hashed).toMatch(/^my_server__x_[0-9a-f]{8}$/);
    expect(names.get(hashed ?? '')).toEqual(changed);
  });

  it('gives the same names whatever order the tools come in', () => {
    const tools = [tool('a.b', 'c'), tool('a_b', 'c'), tool('a-b', 'c.d'), tool('zed', 'y')];
    const forward = [...runToolNames(tools).names];
    const backward = [...runToolNames([...tools].reverse()).names];
    expect(new Map(backward)).toEqual(new Map(forward));
    for (const [name] of forward) {
      expect(name).toMatch(FUNCTION_NAME);
    }
  });

  it('hashes both names when neither collider is unchanged', () => {
    const { names } = runToolNames([tool('a.b', 'c'), tool('a b', 'c')]);
    expect([...names.keys()].every((name) => /^a_b__c_[0-9a-f]{8}$/.test(name))).toBe(true);
    expect(names.size).toBe(2);
  });
});
