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
 * Adds an agent and lets the harness's workspace run it with the servers it grants.
 *
 * @param id - Its id.
 * @param granted - The servers the workspace grants it.
 */
async function addAgent(id: string, granted: string[]): Promise<void> {
  const { createAgent } = await h.asUser.expectOk(CREATE_AGENT, {
    document: {
      spec: 'cubicecho.agent/2',
      id,
      model: { model: 'fake/m1' },
      prompt: [{ role: 'system', name: 'role', content: 'You look after the router.' }],
      tools: { maxIterations: 4 },
    },
  });
  await h.offer(h.workspaceId, createAgent.id, granted);
}

/** Grants the harness's workspace `agents:read` on the admin server. */
async function grantAgentsRead(): Promise<void> {
  const [row] = await h.db.select({ id: servers.id }).from(servers).where(eq(servers.name, RESERVED_SERVER_NAME));
  await h.asUser.expectOk(CREATE_ENTRY, {
    values: { workspaceId: h.workspaceId, serverId: row?.id, roles: [AdminRole.AgentsRead] },
  });
}

describe('an agent run and the admin server', () => {
  it('gets the tools its roles reach when the workspace grants it, and calls them as the run', async () => {
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

  it('gives none of its tools to an agent the workspace did not grant it, whatever the roles', async () => {
    await grantAgentsRead();
    await addAgent('wide', ['fix.ture']);
    h.script = () => ({ content: 'done' });
    const { base } = await h.startRouter();
    const response = await h.complete(base, { model: 'wide', messages: [QUESTION] });
    expect(response.status).toBe(HttpStatus.Ok);
    const declared = sentToolNames(h.received[0]);
    expect(declared).toContain(ECHO);
    expect(declared.filter((name) => name.startsWith(`${RESERVED_SERVER_NAME}__`))).toEqual([]);
  });
});
