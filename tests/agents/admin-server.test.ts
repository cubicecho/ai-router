import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { AdminRole } from '../../server/core/admin-roles.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { servers } from '../../server/db/tables/servers.ts';
import { RESERVED_SERVER_NAME } from '../../server/tools/shapes.ts';
import {
  CREATE_AGENT,
  CREATE_ENTRY,
  ECHO,
  GRANT,
  lastMessage,
  QUESTION,
  sentToolNames,
  useRunHarness,
} from './run-harness.ts';

// An agent reaches the admin server only by naming it, and its run is given the tools its workspace's roles reach.

const h = useRunHarness();

/** What the admin server's `agents` tool is called as, once the router has named it for the model. */
const AGENTS_TOOL = 'ai-router__agents';

/**
 * Adds an agent and lets the harness's workspace run it.
 *
 * @param id - Its id.
 * @param servers - Its `tools.servers`, or undefined for every server.
 */
async function addAgent(id: string, servers: string[] | undefined): Promise<void> {
  const { createAgent } = await h.asUser.expectOk(CREATE_AGENT, {
    document: {
      spec: 'cubicecho.agent/1',
      id,
      model: { model: 'fake/m1' },
      prompt: [{ id: 'role', text: 'You look after the router.' }],
      tools: { ...(servers === undefined ? {} : { servers }), maxIterations: 4 },
    },
  });
  await h.asUser.expectOk(GRANT, { v: { workspaceId: h.workspaceId, agentId: createAgent.id } });
}

/** Grants the harness's workspace `agents:read` on the admin server. */
async function grantAgentsRead(): Promise<void> {
  const [row] = await h.db.select({ id: servers.id }).from(servers).where(eq(servers.name, RESERVED_SERVER_NAME));
  await h.asUser.expectOk(CREATE_ENTRY, {
    values: { workspaceId: h.workspaceId, serverId: row?.id, roles: [AdminRole.AgentsRead] },
  });
}

describe('an agent run and the admin server', () => {
  it('gets the tools its roles reach when the agent names it, and calls them as the run', async () => {
    await grantAgentsRead();
    await addAgent('keeper', ['fix.ture', RESERVED_SERVER_NAME]);
    h.script = (body) =>
      lastMessage(body).role === 'tool'
        ? { content: `Seen: ${lastMessage(body).content}` }
        : { call: { name: AGENTS_TOOL, args: {} } };
    const { base } = await h.startRouter();
    const response = await h.complete(base, { model: 'keeper', messages: [QUESTION] });
    expect(response.status).toBe(HttpStatus.Ok);

    const declared = sentToolNames(h.received[0]);
    expect(declared).toEqual(expect.arrayContaining([ECHO, AGENTS_TOOL, 'ai-router__check_agent']));
    expect(declared).not.toContain('ai-router__create_agent');
    const answer = await response.json();
    expect(answer.choices[0].message.content).toContain('"name": "helper"');
  });

  it('is never in "every server": an agent with no server list gets none of its tools', async () => {
    await grantAgentsRead();
    await addAgent('wide', undefined);
    h.script = () => ({ content: 'done' });
    const { base } = await h.startRouter();
    const response = await h.complete(base, { model: 'wide', messages: [QUESTION] });
    expect(response.status).toBe(HttpStatus.Ok);
    const declared = sentToolNames(h.received[0]);
    expect(declared).toContain(ECHO);
    expect(declared.filter((name) => name.startsWith(`${RESERVED_SERVER_NAME}__`))).toEqual([]);
  });
});
