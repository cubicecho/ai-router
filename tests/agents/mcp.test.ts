import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpStatus } from '../../server/core/wire.ts';
import { RunStatus, runs } from '../../server/db/tables/runs.ts';
import { createWorkspaceWithKey } from '../helpers.ts';
import { lastMessage, QUESTION, sentMessages, until, useRunHarness } from './run-harness.ts';

// /mcp offers each agent a workspace key may run as an MCP tool: a message in, the answer out, progress as MCP
// progress notifications, and every call a run recorded under the workspace.

const h = useRunHarness();

/** The clients a test opened, closed after it. */
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
});

/**
 * Connects an MCP client to the router's /mcp.
 *
 * @param base - The router.
 * @param [secret] - The key, the harness's own by default.
 * @returns The connected client.
 */
async function connect(base: string, secret = h.keySecret): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${secret}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

/**
 * Reads the text a tool answered with.
 *
 * @param result - The tool's result.
 * @returns Its first text part.
 */
function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const [first] = Array.isArray(result.content) ? result.content : [];
  return first?.type === 'text' ? first.text : '';
}

describe('/mcp', () => {
  it("lists the agents the key's workspace may run as tools, and refuses no key", async () => {
    const { base } = await h.startRouter();
    const { tools } = await (await connect(base)).listTools();
    expect(tools).toEqual([
      expect.objectContaining({
        name: 'helper',
        title: 'Helper',
        description: expect.stringContaining('Answers with what its tool said.'),
        inputSchema: expect.objectContaining({ required: ['message'] }),
      }),
    ]);

    const other = await createWorkspaceWithKey(h.db, 'min-agent');
    await h.snapshot.rebuild();
    expect((await (await connect(base, other.secret)).listTools()).tools).toEqual([]);

    const none = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(none.status).toBe(HttpStatus.Unauthorized);
    expect(await none.json()).toMatchObject({ jsonrpc: '2.0', error: { message: expect.stringContaining('key') } });
  });

  it('runs the agent on the message, with progress, as a run recorded under the workspace', async () => {
    const { base } = await h.startRouter();
    const client = await connect(base);
    const steps: string[] = [];
    const result = await client.callTool({ name: 'helper', arguments: { message: 'hello there' } }, undefined, {
      onprogress: (progress) => steps.push(progress.message ?? ''),
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('The tool said: hello there');
    expect(steps).toContain('Calling fix_ture__echo');

    const [row] = await h.db.select().from(runs);
    expect(row).toMatchObject({ workspaceId: h.workspaceId, agentName: 'helper', status: RunStatus.Completed });
    expect(row?.input).toEqual([QUESTION]);
    expect(result._meta).toEqual({ runId: row?.id });
  });

  it('carries a conversation on across calls that name it, and keeps calls without one apart', async () => {
    h.script = (body) => ({ content: `heard ${sentMessages(body).length}: ${lastMessage(body).content}` });
    const { base } = await h.startRouter();
    const client = await connect(base);
    await client.callTool({ name: 'helper', arguments: { message: 'one', conversation: 'chat' } });
    const second = await client.callTool({ name: 'helper', arguments: { message: 'two', conversation: 'chat' } });
    // The system prompt, the first exchange, and the new message.
    expect(textOf(second)).toBe('heard 4: two');
    const alone = await client.callTool({ name: 'helper', arguments: { message: 'three' } });
    expect(textOf(alone)).toBe('heard 2: three');
  });

  it('refuses an agent the key may not run and a call with no message, and reports a failed run as an error', async () => {
    const { base } = await h.startRouter();
    const client = await connect(base);
    await expect(client.callTool({ name: 'nobody', arguments: { message: 'hi' } })).rejects.toThrow(
      'There is no agent named "nobody" for this key.',
    );
    await expect(client.callTool({ name: 'helper', arguments: { message: ' ' } })).rejects.toThrow('message');
    expect(await h.db.select().from(runs)).toEqual([]);

    h.script = () => ({ call: { name: 'fix_ture__fail', args: {} } });
    const failing = await client.callTool({ name: 'helper', arguments: { message: 'hi' } });
    expect(failing.isError).toBe(true);
    expect(textOf(failing)).toContain('Run ');
  });

  it('cancels the run when the client cancels the call', async () => {
    h.script = () => ({ call: { name: 'fix_ture__sleep', args: { ms: 60_000 } } });
    const { base } = await h.startRouter();
    const client = await connect(base);
    const stop = new AbortController();
    const call = client.callTool({ name: 'helper', arguments: { message: 'hi' } }, undefined, { signal: stop.signal });
    await until(() => h.received.length > 0, 'the model call');
    stop.abort();
    await expect(call).rejects.toThrow();
    const [row] = await h.db.select({ id: runs.id }).from(runs);
    const cancelled = await h.runReaches(row?.id ?? '', RunStatus.Cancelled);
    expect(cancelled.error).toBe('The app disconnected.');
    expect(await h.db.select().from(runs).where(eq(runs.status, RunStatus.Running))).toEqual([]);
  });
});
