import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_RULES } from '../../server/agents/policy.ts';
import type { UserCaller } from '../../server/core/context.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { createSnapshotHost } from '../../server/db/snapshot.ts';
import { pools } from '../../server/db/tables/pools.ts';
import { providers } from '../../server/db/tables/providers.ts';
import { servers } from '../../server/db/tables/servers.ts';
import { usageCounts } from '../../server/db/tables/usage-counts.ts';
import { Role } from '../../server/db/tables/users.ts';
import {
  closeTestDb,
  createClient,
  createTestDb,
  createUser,
  createWorkspaceWithKey,
  resetTestDb,
  type TestClient,
  type TestDb,
} from '../helpers.ts';

const CREATE = `mutation ($document: JSON!, $message: String) {
  createAgent(document: $document, message: $message) { id name liveRevisionId overridePolicyId }
}`;
const SAVE = `mutation ($id: UUID!, $document: JSON!, $message: String) {
  saveAgent(id: $id, document: $document, message: $message) { id number document warnings message createdBy promotedAt }
}`;
const PROMOTE = 'mutation ($id: UUID!) { promoteRevision(id: $id) { id liveRevisionId } }';
const CHECK = `query ($document: JSON!, $id: UUID) { checkAgent(document: $document, id: $id) { errors warnings } }`;
const HISTORY = `query ($id: UUID!) {
  agent(where: { id: { eq: $id } }) {
    name liveRevisionId
    revisions(orderBy: { number: { direction: asc, priority: 1 } }) { id number message promotedAt creator { email } }
    overridePolicy { name rules }
  }
}`;

/** A document that names only what the router has. */
const FINANCE = {
  spec: 'cubicecho.agent/2',
  id: 'personal-finance',
  name: 'Personal Finance',
  model: { model: 'ollama/qwen3:32b', temperature: 0.3 },
  prompt: [{ role: 'system', name: 'identity', content: 'You help me run my household money.' }],
  tools: { maxIterations: 20 },
  tasks: { title: { model: 'small' } },
};

let db: TestDb;
let user: UserCaller;
let asUser: TestClient;

/**
 * Makes the agent through the API.
 *
 * @param [document] - Its first document.
 * @returns Its id and first revision's id.
 */
async function makeAgent(document: Record<string, unknown> = FINANCE): Promise<{ id: string; first: string }> {
  const { createAgent } = await asUser.expectOk(CREATE, { document, message: 'First.' });
  return { id: createAgent.id, first: createAgent.liveRevisionId };
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
  user = await createUser(db, 'user@example.com', Role.User);
  asUser = createClient(db, user);
  await db.insert(providers).values({ name: 'ollama', baseUrl: 'http://ollama:11434/v1' });
  await db.insert(pools).values({ name: 'small' });
  await db.insert(servers).values({
    name: 'actual',
    source: { type: 'manual' },
    transport: { type: 'stdio', command: 'node', args: [] },
  });
});

describe('creating an agent', () => {
  it('names it by the document id, makes the first revision live, and gives it the default policy', async () => {
    const { id, first } = await makeAgent();
    const { agent } = await asUser.expectOk(HISTORY, { id });
    expect(agent).toMatchObject({
      name: 'personal-finance',
      liveRevisionId: first,
      overridePolicy: { name: 'default', rules: DEFAULT_POLICY_RULES },
    });
    expect(agent.revisions).toEqual([
      {
        id: first,
        number: 1,
        message: 'First.',
        promotedAt: expect.anything(),
        creator: { email: 'user@example.com' },
      },
    ]);
  });

  it('stores the document as received, unknown keys included', async () => {
    const { id } = await makeAgent({ ...FINANCE, futureField: { kept: true } });
    const { agent } = await asUser.expectOk(
      'query ($id: UUID!) { agent(where: { id: { eq: $id } }) { liveRevision { document warnings } } }',
      { id },
    );
    expect(agent.liveRevision.document).toEqual({ ...FINANCE, futureField: { kept: true } });
  });

  it.each([
    ['no spec token', { id: 'a' }, 'spec'],
    ['another major', { spec: 'cubicecho.agent/3', id: 'a' }, 'spec'],
    ['no id', { spec: 'cubicecho.agent/2' }, 'needs an id'],
    ['an id breaking the name rule', { spec: 'cubicecho.agent/2', id: 'Personal Finance' }, 'id:'],
    [
      'a part named as an app part',
      { ...FINANCE, prompt: [{ role: 'system', name: 'app_lane', content: 'x' }] },
      'app',
    ],
    ['an extension this router does not understand', { ...FINANCE, requires: ['com.example.x'] }, 'requires'],
  ])('refuses a document with %s, saying why', async (_label, document, why) => {
    const refused = await asUser.expectError(CREATE, { document });
    expect(refused.code).toBe(ErrorCode.BadUserInput);
    expect(refused.message).toContain(why);
  });

  it('upgrades a version 1 document and keeps it as version 2, saying so', async () => {
    const old = {
      ...FINANCE,
      spec: 'cubicecho.agent/1',
      prompt: [
        { id: 'identity', text: 'You help me run my household money.' },
        { id: 'rules', ref: { type: 'file', value: './rules.md' } },
      ],
    };
    const { id } = await makeAgent(old);
    const { agent } = await asUser.expectOk(
      'query ($id: UUID!) { agent(where: { id: { eq: $id } }) { liveRevision { document warnings } } }',
      { id },
    );
    expect(agent.liveRevision.document).toEqual(FINANCE);
    expect(agent.liveRevision.warnings.join(' ')).toContain('version 1');
    expect(agent.liveRevision.warnings.join(' ')).toContain('prompt[1]');
  });

  it('refuses a name already taken', async () => {
    await makeAgent();
    expect((await asUser.expectError(CREATE, { document: FINANCE })).message).toContain('already exists');
  });

  it('takes out a bundled server’s env and headers, and warns', async () => {
    const bundled = {
      ...FINANCE,
      bundle: { mcpServers: [{ id: 'notes', command: 'notes-mcp', env: { NOTES_TOKEN: 'planted-bundle-secret' } }] },
    };
    const { id } = await makeAgent(bundled);
    const answer = JSON.stringify(
      await asUser.expectOk(
        'query ($id: UUID!) { agent(where: { id: { eq: $id } }) { liveRevision { document warnings } } }',
        {
          id,
        },
      ),
    );
    expect(answer).not.toContain('planted-bundle-secret');
    expect(answer).toContain("env and headers aren't kept");
  });
});

describe('warnings', () => {
  it('name what the router lacks, without refusing', async () => {
    const { checkAgent } = await asUser.expectOk(CHECK, {
      document: {
        spec: 'cubicecho.agent/2',
        id: 'x',
        model: { model: 'nowhere/m' },
        tasks: { title: { model: 'no-such-pool' } },
      },
    });
    expect(checkAgent.errors).toEqual([]);
    expect(checkAgent.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('no provider is named "nowhere"'),
        expect.stringContaining('no pool is named "no-such-pool"'),
      ]),
    );
  });

  it('say the router ignores a server list, which a workspace decides instead', async () => {
    const { checkAgent } = await asUser.expectOk(CHECK, {
      document: { ...FINANCE, tools: { servers: ['actual'] } },
    });
    expect(checkAgent).toEqual({
      errors: [],
      warnings: [expect.stringContaining('tools.servers: ai-router ignores it')],
    });
  });

  it('are none for a document that names only what the router has', async () => {
    expect((await asUser.expectOk(CHECK, { document: FINANCE })).checkAgent).toEqual({ errors: [], warnings: [] });
  });

  it('say an agent with its own endpoint skips the router’s models', async () => {
    const { checkAgent } = await asUser.expectOk(CHECK, {
      document: { ...FINANCE, endpoint: { baseUrl: 'http://elsewhere/v1' }, model: { model: 'nowhere/m' } },
    });
    expect(checkAgent.warnings).toEqual([expect.stringContaining('calls that address directly')]);
  });
});

describe('revisions', () => {
  it('number each save, make it live, and keep every earlier one', async () => {
    const { id, first } = await makeAgent();
    const { saveAgent } = await asUser.expectOk(SAVE, {
      id,
      document: { ...FINANCE, description: 'Now with bills.' },
      message: 'Bills.',
    });
    expect(saveAgent).toMatchObject({ number: 2, message: 'Bills.', createdBy: user.userId });
    const { agent } = await asUser.expectOk(HISTORY, { id });
    expect(agent.liveRevisionId).toBe(saveAgent.id);
    expect(agent.revisions.map((revision: { id: string }) => revision.id)).toEqual([first, saveAgent.id]);
  });

  it('refuse a document for another agent', async () => {
    const { id } = await makeAgent();
    const { message } = await asUser.expectError(SAVE, { id, document: { ...FINANCE, id: 'coding' } });
    expect(message).toContain('this is agent "personal-finance"');
  });

  it('roll back when an older one is made live again', async () => {
    const { id, first } = await makeAgent();
    await asUser.expectOk(SAVE, { id, document: { ...FINANCE, description: 'Two.' } });
    const { promoteRevision } = await asUser.expectOk(PROMOTE, { id: first });
    expect(promoteRevision).toEqual({ id, liveRevisionId: first });
  });

  it('cannot be written by generated CRUD', async () => {
    for (const field of ['createAgentRevision', 'updateAgentRevision', 'deleteAgentRevision', 'updateAgent']) {
      const { message } = await asUser.expectError(`mutation { ${field} { id } }`);
      expect(message).toContain(`Cannot query field "${field}"`);
    }
  });
});

describe('the snapshot', () => {
  it('holds each agent’s live document, its policy and the workspaces that may run it', async () => {
    const snapshot = await createSnapshotHost(db);
    const client = createClient(db, user, { snapshot });
    const { createAgent } = await client.expectOk(CREATE, { document: FINANCE });
    const { workspaceId } = await createWorkspaceWithKey(db, 'min-agent');
    await client.expectOk('mutation ($v: CreateWorkspaceAgentInput!) { createWorkspaceAgent(values: $v) { id } }', {
      v: { workspaceId, agentId: createAgent.id },
    });
    const agent = snapshot.current().agents.get('personal-finance');
    expect(agent).toMatchObject({
      liveRevisionId: createAgent.liveRevisionId,
      document: FINANCE,
      policy: DEFAULT_POLICY_RULES,
    });
    // Offered with no servers granted yet, so its runs there reach none.
    expect([...(agent?.workspaces ?? [])]).toEqual([[workspaceId, []]]);
  });
});

describe('deleting an agent', () => {
  it('takes its revisions and workspace entries, and keeps its usage by name', async () => {
    const { id } = await makeAgent();
    await db
      .insert(usageCounts)
      .values({ agentId: id, agentName: 'personal-finance', providerName: 'ollama', model: 'm' });
    await asUser.expectOk('mutation ($id: UUID!) { deleteAgent(where: { id: { eq: $id } }) { id } }', { id });
    expect((await asUser.expectOk('{ agentRevisions { id } }')).agentRevisions).toEqual([]);
    const [usage] = await db.select().from(usageCounts);
    expect(usage).toMatchObject({ agentId: null, agentName: 'personal-finance' });
  });
});

describe('who may', () => {
  it('refuses a workspace key everything', async () => {
    const { workspaceId, keyId } = await createWorkspaceWithKey(db, 'min-agent');
    const asKey = createClient(db, { kind: 'workspace', workspaceId, keyId });
    expect((await asKey.expectError(CREATE, { document: FINANCE })).code).toBe(ErrorCode.Forbidden);
  });
});
