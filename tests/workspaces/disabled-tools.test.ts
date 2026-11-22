import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { AdminRole } from '../../server/core/admin-roles.ts';
import { CALLER_RUN } from '../../server/core/context.ts';
import { WORKSPACE_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { workspaceAgentDisabledTools } from '../../server/db/tables/workspace-agent-disabled-tools.ts';
import { workspaceKeys } from '../../server/db/tables/workspace-keys.ts';
import { RESERVED_SERVER_NAME } from '../../server/tools/shapes.ts';
import {
  CREATE_AGENT,
  CREATE_ENTRY,
  ECHO,
  lastMessage,
  QUESTION,
  SERVER,
  SET_SERVER_ENABLED,
  sentToolNames,
  useRunHarness,
} from '../agents/run-harness.ts';
import { createClient, workspaceCaller } from '../helpers.ts';

// Single tools of a workspace's server turned off for one agent there: left out before the run names its tools.

const h = useRunHarness();

const SET_TOOL_ENABLED = `mutation ($workspaceAgentId: UUID!, $serverId: UUID!, $tool: String!, $enabled: Boolean!) {
  setWorkspaceAgentToolEnabled(workspaceAgentId: $workspaceAgentId, serverId: $serverId, tool: $tool, enabled: $enabled)
}`;
const REMOVE_ENTRY = 'mutation ($id: UUID!) { deleteWorkspaceServer(where: { id: { eq: $id } }) { id } }';
/** What the fixture's `pid` is called as, once the router has named it for the model. */
const PID = 'fix_ture__pid';
/** The header that names the app tools a run left out. */
const PRUNED = 'x-ai-router-pruned-tools';

/**
 * Reads a server's id from the snapshot.
 *
 * @param [name] - The server.
 * @returns Its id.
 */
function serverIdOf(name = SERVER): string {
  const id = h.snapshot.current().servers.get(name)?.id;
  if (id === undefined) {
    throw new Error(`The router has no server ${name}.`);
  }
  return id;
}

/**
 * Turns one of the fixture's tools on or off for the helper, as a person does.
 *
 * @param tool - The tool's own name on the fixture.
 * @param enabled - Whether it is to be on.
 * @param [serverName] - The server it belongs to.
 */
async function setTool(tool: string, enabled: boolean, serverName = SERVER): Promise<void> {
  const { setWorkspaceAgentToolEnabled } = await h.asUser.expectOk(SET_TOOL_ENABLED, {
    workspaceAgentId: h.helperEntryId,
    serverId: serverIdOf(serverName),
    tool,
    enabled,
  });
  expect(setWorkspaceAgentToolEnabled).toBe(enabled);
}

/**
 * Runs the helper once, answering at once, and reads the tools it named for the model.
 *
 * @param base - The router.
 * @returns The function names its first model request declared.
 */
async function declaredTools(base: string): Promise<string[]> {
  h.script = () => ({ content: 'done' });
  h.received = [];
  const response = await h.complete(base, { model: 'helper', messages: [QUESTION] });
  expect(response.status).toBe(HttpStatus.Ok);
  await response.json();
  return sentToolNames(h.received[0]);
}

describe("a workspace server's tools turned off for one agent", () => {
  it('are not named for the model while the others are, and a call to one is refused, never forwarded', async () => {
    await setTool('echo', false);
    // Twice is the same as once.
    await setTool('echo', false);
    const { base } = await h.startRouter();
    const declared = await declaredTools(base);
    expect(declared).not.toContain(ECHO);
    expect(declared).toContain(PID);

    // The model calls it anyway: the run has no such tool, so the fixture never sees the call.
    h.script = (body) =>
      lastMessage(body).role === 'tool'
        ? { content: `Seen: ${lastMessage(body).content}` }
        : { call: { name: ECHO, args: { text: 'hi' } } };
    h.received = [];
    const response = await h.complete(base, { model: 'helper', messages: [QUESTION] });
    expect(response.status).toBe(HttpStatus.Ok);
    await response.json();
    expect(lastMessage(h.received[1] ?? {}).content).toContain(`no tool named "${ECHO}"`);

    await setTool('echo', true);
    expect(await declaredTools(base)).toContain(ECHO);
  });

  it('stay off only for that agent', async () => {
    await setTool('echo', false);
    const { createAgent } = await h.asUser.expectOk(CREATE_AGENT, {
      document: { spec: 'cubicecho.agent/2', id: 'other', model: { model: 'fake/m1' } },
    });
    await h.offer(h.workspaceId, createAgent.id);
    const { base } = await h.startRouter();
    h.script = () => ({ content: 'done' });
    const response = await h.complete(base, { model: 'other', messages: [QUESTION] });
    expect(response.status).toBe(HttpStatus.Ok);
    await response.json();
    expect(sentToolNames(h.received[0])).toContain(ECHO);
  });

  it('are all off with their server, and come back as they were when the server is turned on', async () => {
    await setTool('echo', false);
    const serverSwitch = { workspaceAgentId: h.helperEntryId, serverId: serverIdOf(), enabled: false };
    await h.asUser.expectOk(SET_SERVER_ENABLED, serverSwitch);
    const { base } = await h.startRouter();
    expect((await declaredTools(base)).filter((name) => name.startsWith('fix_ture__'))).toEqual([]);

    await h.asUser.expectOk(SET_SERVER_ENABLED, { ...serverSwitch, enabled: true });
    const declared = await declaredTools(base);
    expect(declared).toContain(PID);
    expect(declared).not.toContain(ECHO);
  });

  it('are forgotten when the server is taken out of the workspace', async () => {
    await setTool('echo', false);
    const entryId = h.snapshot.current().servers.get(SERVER)?.entries.get(h.workspaceId)?.id;
    await h.asUser.expectOk(REMOVE_ENTRY, { id: entryId });
    expect(await h.db.select().from(workspaceAgentDisabledTools)).toEqual([]);
  });

  it("narrow the admin server's role-limited tools, and never widen them", async () => {
    const adminId = serverIdOf(RESERVED_SERVER_NAME);
    await h.asUser.expectOk(CREATE_ENTRY, {
      values: { workspaceId: h.workspaceId, serverId: adminId, roles: [AdminRole.AgentsRead] },
    });
    await setTool('check_agent', false, RESERVED_SERVER_NAME);
    // Turning on a tool the roles don't reach is only a row that changes nothing.
    await setTool('create_agent', true, RESERVED_SERVER_NAME);
    const { base } = await h.startRouter();
    const declared = await declaredTools(base);
    expect(declared).toContain('ai-router__agents');
    expect(declared).not.toContain('ai-router__check_agent');
    expect(declared).not.toContain('ai-router__create_agent');
  });

  it("let an app tool that duplicates one through to the app, since the agent's is gone", async () => {
    await setTool('echo', false);
    const { base } = await h.startRouter();
    h.script = () => ({ call: { name: ECHO, args: { text: 'hi' } } });
    const response = await h.complete(base, {
      model: 'helper',
      messages: [QUESTION],
      tools: [{ type: 'function', function: { name: ECHO, parameters: { type: 'object' } } }],
    });
    expect(response.status).toBe(HttpStatus.Ok);
    expect(response.headers.get(PRUNED)).toBeNull();
    const answer = await response.json();
    expect(answer.choices[0]).toMatchObject({ finish_reason: 'tool_calls' });
    expect(answer.choices[0].message.tool_calls[0].function.name).toBe(ECHO);
    expect(sentToolNames(h.received[0]).filter((name) => name === ECHO)).toHaveLength(1);
  });

  it("can be switched only where the workspace runs the agent and has the server, and by a tool's name", async () => {
    const missingId = '00000000-0000-4000-8000-000000000000';
    const adminId = serverIdOf(RESERVED_SERVER_NAME);
    const notInWorkspace = await h.asUser.expectError(SET_TOOL_ENABLED, {
      workspaceAgentId: h.helperEntryId,
      serverId: adminId,
      tool: 'agents',
      enabled: false,
    });
    expect(notInWorkspace.code).toBe(ErrorCode.NotFound);
    const unknownEntry = await h.asUser.expectError(SET_TOOL_ENABLED, {
      workspaceAgentId: missingId,
      serverId: serverIdOf(),
      tool: 'echo',
      enabled: false,
    });
    expect(unknownEntry.code).toBe(ErrorCode.NotFound);
    for (const tool of ['', 'x'.repeat(WORKSPACE_DEFAULTS.maxToolNameLength + 1)]) {
      const bad = await h.asUser.expectError(SET_TOOL_ENABLED, {
        workspaceAgentId: h.helperEntryId,
        serverId: serverIdOf(),
        tool,
        enabled: false,
      });
      expect(bad.code).toBe(ErrorCode.BadUserInput);
    }
    expect(await h.db.select().from(workspaceAgentDisabledTools)).toEqual([]);
  });

  it('are switched only by a person, never a workspace key or an agent run, whatever its roles', async () => {
    await setTool('echo', false);
    const [key] = await h.db.select({ id: workspaceKeys.id }).from(workspaceKeys);
    const asKey = createClient(h.db, workspaceCaller(h.workspaceId, key?.id ?? ''));
    const asRun = createClient(h.db, {
      kind: CALLER_RUN,
      runId: '00000000-0000-4000-8000-000000000001',
      workspaceId: h.workspaceId,
      agentId: h.agentId,
      roles: Object.values(AdminRole),
      depth: 1,
    });
    for (const caller of [asKey, asRun]) {
      const turnOn = await caller.expectError(SET_TOOL_ENABLED, {
        workspaceAgentId: h.helperEntryId,
        serverId: serverIdOf(),
        tool: 'echo',
        enabled: true,
      });
      expect(turnOn.code).toBe(ErrorCode.Forbidden);
    }
    const rows = await h.db
      .select({ tool: workspaceAgentDisabledTools.tool })
      .from(workspaceAgentDisabledTools)
      .where(eq(workspaceAgentDisabledTools.workspaceAgentId, h.helperEntryId));
    expect(rows).toEqual([{ tool: 'echo' }]);
  });
});
