import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_ROLES } from '../../server/core/admin-roles.ts';
import { CALLER_RUN, type UserCaller } from '../../server/core/context.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import type { LanServerSuggestion, LanServers } from '../../server/discovery/lan-servers.ts';
import {
  closeTestDb,
  createClient,
  createTestDb,
  createUser,
  createWorkspaceWithKey,
  type TestDb,
  workspaceCaller,
} from '../helpers.ts';

const LAN_SERVERS = `{
  lanServers {
    watching
    servers { key cardName title description version host url requiredHeaders suggestedName addedAs }
  }
}`;

/** One server found on the network. */
const FOUND: LanServerSuggestion = {
  key: 'MCP Skills on nas/io.github.cubicecho.mcp-skills.nas/skills',
  cardName: 'io.github.cubicecho.mcp-skills.nas/skills',
  title: 'Skills',
  description: 'Skills for agents.',
  version: '4.0.0',
  host: 'MCP Skills on nas',
  url: 'http://192.168.1.20:3000/mcp',
  requiredHeaders: ['Authorization'],
  suggestedName: 'skills',
  addedAs: null,
};

/** A watch that has found one server. */
const lanServers: LanServers = {
  isWatching: () => true,
  sync: async () => undefined,
  list: () => [FOUND],
  close: async () => undefined,
};

let db: TestDb;
let user: UserCaller;
let workspace: { workspaceId: string; keyId: string };

beforeAll(async () => {
  db = await createTestDb();
  user = await createUser(db, 'ada@example.com');
  workspace = await createWorkspaceWithKey(db, 'min-agent');
});

afterAll(() => closeTestDb(db));

describe('lanServers', () => {
  it('lists what the watch found, for any person', async () => {
    const { lanServers: answer } = await createClient(db, user, { lanServers }).expectOk(LAN_SERVERS);
    expect(answer).toEqual({ watching: true, servers: [FOUND] });
  });

  it('is empty, and says so, when the router is not watching', async () => {
    const { lanServers: answer } = await createClient(db, user).expectOk(LAN_SERVERS);
    expect(answer).toEqual({ watching: false, servers: [] });
  });

  it('is refused to a workspace key', async () => {
    const caller = workspaceCaller(workspace.workspaceId, workspace.keyId);
    const refused = await createClient(db, caller, { lanServers }).expectError(LAN_SERVERS);
    expect(refused.code).toBe(ErrorCode.Forbidden);
  });

  it('is refused to an agent run, whatever its roles', async () => {
    const caller = {
      kind: CALLER_RUN,
      runId: 'run-1',
      agentId: 'agent-1',
      workspaceId: workspace.workspaceId,
      roles: ADMIN_ROLES,
      depth: 1,
    };
    const refused = await createClient(db, caller, { lanServers }).expectError(LAN_SERVERS);
    expect(refused.code).toBe(ErrorCode.Forbidden);
  });
});
