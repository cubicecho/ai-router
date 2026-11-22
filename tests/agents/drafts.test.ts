import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_ROLES, AdminRole } from '../../server/core/admin-roles.ts';
import { CALLER_RUN, type RunCaller, type UserCaller } from '../../server/core/context.ts';
import { ErrorCode } from '../../server/core/errors.ts';
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

const CREATE = `mutation ($document: JSON!) {
  createAgent(document: $document) { id liveRevisionId }
}`;
const SAVE = `mutation ($id: UUID!, $document: JSON!, $basedOn: UUID) {
  saveAgent(id: $id, document: $document, basedOn: $basedOn) {
    id number createdBy savedByWorkspaceId savedByAgentId basedOnId promotedAt
  }
}`;
const PROMOTE = 'mutation ($id: UUID!) { promoteRevision(id: $id) { id liveRevisionId } }';
const DISCARD = 'mutation ($id: UUID!) { discardRevision(id: $id) { id liveRevisionId } }';
const AUTO_PROMOTE = `mutation ($id: UUID!, $autoPromote: Boolean!) {
  setAgentAutoPromote(id: $id, autoPromote: $autoPromote) { id autoPromote }
}`;
const REVISIONS = `query ($id: UUID!) {
  agent(where: { id: { eq: $id } }) {
    liveRevisionId autoPromote
    revisions(orderBy: { number: { direction: asc, priority: 1 } }) {
      id number promotedAt
      creator { email }
      savedByWorkspace { name }
      savedByAgent { name }
      basedOn { number }
    }
  }
}`;

/**
 * Builds an agent document with no reach, so it warns about nothing the tests care about.
 *
 * @param id - The agent's name.
 * @param [description] - Something to change between saves.
 * @returns The document.
 */
const document = (id: string, description = '') => ({
  spec: 'cubicecho.agent/2',
  id,
  description,
  model: { model: 'ollama/m' },
  tools: { servers: [] },
});

let db: TestDb;
let user: UserCaller;
let asUser: TestClient;
let workspaceId: string;
/** The agent whose runs save drafts in these tests. */
let author: { id: string; first: string };

/**
 * Makes an agent as the person.
 *
 * @param id - Its name.
 * @returns Its id and first revision's id.
 */
async function makeAgent(id: string): Promise<{ id: string; first: string }> {
  const { createAgent } = await asUser.expectOk(CREATE, { document: document(id) });
  return { id: createAgent.id, first: createAgent.liveRevisionId };
}

/**
 * Makes a client for a run calling the admin server.
 *
 * @param [overrides] - What differs from a run of `author` in `workspaceId` with agents:manage.
 * @returns The client.
 */
function asRunOf(overrides: Partial<Pick<RunCaller, 'workspaceId' | 'agentId' | 'roles'>> = {}): TestClient {
  const caller: RunCaller = {
    kind: CALLER_RUN,
    runId: randomUUID(),
    workspaceId,
    agentId: author.id,
    roles: [AdminRole.AgentsManage],
    depth: 1,
    ...overrides,
  };
  return createClient(db, caller);
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
  user = await createUser(db, 'user@example.com', Role.User);
  asUser = createClient(db, user);
  ({ workspaceId } = await createWorkspaceWithKey(db, 'task-server'));
  author = await makeAgent('author');
});

describe("a person's save", () => {
  it('goes live, records the person, and is based on the live revision', async () => {
    const { id, first } = await makeAgent('coding');
    const { saveAgent } = await asUser.expectOk(SAVE, { id, document: document('coding', 'Two.') });
    expect(saveAgent).toMatchObject({
      number: 2,
      createdBy: user.userId,
      savedByWorkspaceId: null,
      savedByAgentId: null,
      basedOnId: first,
      promotedAt: expect.anything(),
    });
    const { agent } = await asUser.expectOk(REVISIONS, { id });
    expect(agent.liveRevisionId).toBe(saveAgent.id);
  });

  it('goes live even when the agent auto-promotes', async () => {
    const { id } = await makeAgent('coding');
    await asUser.expectOk(AUTO_PROMOTE, { id, autoPromote: true });
    const { saveAgent } = await asUser.expectOk(SAVE, { id, document: document('coding', 'Two.') });
    expect(saveAgent.promotedAt).not.toBeNull();
  });

  it('records the revision it says it started from', async () => {
    const { id, first } = await makeAgent('coding');
    await asUser.expectOk(SAVE, { id, document: document('coding', 'Two.') });
    const { saveAgent } = await asUser.expectOk(SAVE, { id, document: document('coding', 'Three.'), basedOn: first });
    expect(saveAgent.basedOnId).toBe(first);
    const { agent } = await asUser.expectOk(REVISIONS, { id });
    expect(agent.revisions.map((revision: { basedOn: { number: number } | null }) => revision.basedOn)).toEqual([
      null,
      { number: 1 },
      { number: 1 },
    ]);
  });

  it.each([
    ['another agent’s revision', true],
    ['an id that is no revision', false],
  ])('refuses basedOn naming %s', async (_label, isAnotherAgents) => {
    const { id } = await makeAgent('coding');
    const basedOn = isAnotherAgents ? author.first : randomUUID();
    const refused = await asUser.expectError(SAVE, { id, document: document('coding', 'Two.'), basedOn });
    expect(refused.code).toBe(ErrorCode.BadUserInput);
    expect(refused.message).toContain('basedOn');
  });
});

describe("a run's save", () => {
  it("is a draft that isn't live, recording the workspace and agent and no person", async () => {
    const { id, first } = await makeAgent('coding');
    const { saveAgent } = await asRunOf().expectOk(SAVE, { id, document: document('coding', 'Drafted.') });
    expect(saveAgent).toMatchObject({
      number: 2,
      createdBy: null,
      savedByWorkspaceId: workspaceId,
      savedByAgentId: author.id,
      basedOnId: first,
      promotedAt: null,
    });
    const { agent } = await asUser.expectOk(REVISIONS, { id });
    expect(agent.liveRevisionId).toBe(first);
    expect(agent.revisions[1]).toMatchObject({
      creator: null,
      savedByWorkspace: { name: 'task-server' },
      savedByAgent: { name: 'author' },
    });
  });

  it('goes live when the agent auto-promotes', async () => {
    const { id } = await makeAgent('coding');
    await asUser.expectOk(AUTO_PROMOTE, { id, autoPromote: true });
    const { saveAgent } = await asRunOf().expectOk(SAVE, { id, document: document('coding', 'Straight in.') });
    expect(saveAgent.promotedAt).not.toBeNull();
    const { agent } = await asUser.expectOk(REVISIONS, { id });
    expect(agent.liveRevisionId).toBe(saveAgent.id);
  });

  it('of a new agent makes its first revision live, recording who saved it', async () => {
    const { createAgent } = await asRunOf().expectOk(CREATE, { document: document('drafted') });
    const { agent } = await asUser.expectOk(REVISIONS, { id: createAgent.id });
    expect(agent.liveRevisionId).toBe(createAgent.liveRevisionId);
    expect(agent.revisions).toEqual([
      expect.objectContaining({
        creator: null,
        savedByWorkspace: { name: 'task-server' },
        savedByAgent: { name: 'author' },
      }),
    ]);
  });

  it('is refused for a run with only agents:read', async () => {
    const { id } = await makeAgent('coding');
    const asReader = asRunOf({ roles: [AdminRole.AgentsRead] });
    const refused = await asReader.expectError(SAVE, { id, document: document('coding', 'Drafted.') });
    expect(refused.code).toBe(ErrorCode.Forbidden);
  });
});

describe('discarding', () => {
  it('lets a run discard a draft its own agent saved for its workspace', async () => {
    const { id } = await makeAgent('coding');
    const asRun = asRunOf();
    const { saveAgent } = await asRun.expectOk(SAVE, { id, document: document('coding', 'Drafted.') });
    await asRun.expectOk(DISCARD, { id: saveAgent.id });
    const { agent } = await asUser.expectOk(REVISIONS, { id });
    expect(agent.revisions.map((revision: { number: number }) => revision.number)).toEqual([1]);
  });

  it('refuses a run a draft another agent saved, as FORBIDDEN', async () => {
    const { id } = await makeAgent('coding');
    const other = await makeAgent('other-author');
    const { saveAgent } = await asRunOf({ agentId: other.id }).expectOk(SAVE, {
      id,
      document: document('coding', 'Theirs.'),
    });
    expect((await asRunOf().expectError(DISCARD, { id: saveAgent.id })).code).toBe(ErrorCode.Forbidden);
  });

  it('refuses a run a draft saved for another workspace, as FORBIDDEN', async () => {
    const { id } = await makeAgent('coding');
    const { workspaceId: elsewhere } = await createWorkspaceWithKey(db, 'telos');
    const { saveAgent } = await asRunOf({ workspaceId: elsewhere }).expectOk(SAVE, {
      id,
      document: document('coding', 'Theirs.'),
    });
    expect((await asRunOf().expectError(DISCARD, { id: saveAgent.id })).code).toBe(ErrorCode.Forbidden);
  });

  it('lets a person discard any draft, keeping the live revision', async () => {
    const { id, first } = await makeAgent('coding');
    const { saveAgent } = await asRunOf().expectOk(SAVE, { id, document: document('coding', 'Drafted.') });
    const { discardRevision } = await asUser.expectOk(DISCARD, { id: saveAgent.id });
    expect(discardRevision).toEqual({ id, liveRevisionId: first });
  });

  it('refuses a revision that is live, or was ever live', async () => {
    const { id, first } = await makeAgent('coding');
    const { saveAgent } = await asUser.expectOk(SAVE, { id, document: document('coding', 'Two.') });
    for (const revision of [saveAgent.id, first]) {
      const refused = await asUser.expectError(DISCARD, { id: revision });
      expect(refused.code).toBe(ErrorCode.BadUserInput);
      expect(refused.message).toContain('Only a draft can be discarded');
    }
  });

  it('refuses a revision that does not exist, as NOT_FOUND', async () => {
    expect((await asUser.expectError(DISCARD, { id: randomUUID() })).code).toBe(ErrorCode.NotFound);
  });
});

describe('promoting a draft', () => {
  it('makes it live, after which it can no longer be discarded', async () => {
    const { id } = await makeAgent('coding');
    const { saveAgent } = await asRunOf().expectOk(SAVE, { id, document: document('coding', 'Drafted.') });
    expect((await asUser.expectOk(PROMOTE, { id: saveAgent.id })).promoteRevision).toEqual({
      id,
      liveRevisionId: saveAgent.id,
    });
    expect((await asUser.expectError(DISCARD, { id: saveAgent.id })).code).toBe(ErrorCode.BadUserInput);
  });

  it('is refused for a run, whatever its roles', async () => {
    const { id } = await makeAgent('coding');
    const asRun = asRunOf({ roles: ADMIN_ROLES });
    const { saveAgent } = await asRun.expectOk(SAVE, { id, document: document('coding', 'Drafted.') });
    expect((await asRun.expectError(PROMOTE, { id: saveAgent.id })).code).toBe(ErrorCode.Forbidden);
  });
});

describe('auto-promote', () => {
  it('turns on and off, leaving drafts already saved as drafts', async () => {
    const { id, first } = await makeAgent('coding');
    await asRunOf().expectOk(SAVE, { id, document: document('coding', 'Drafted.') });
    expect((await asUser.expectOk(AUTO_PROMOTE, { id, autoPromote: true })).setAgentAutoPromote).toEqual({
      id,
      autoPromote: true,
    });
    const { agent } = await asUser.expectOk(REVISIONS, { id });
    expect(agent).toMatchObject({ autoPromote: true, liveRevisionId: first });
    expect(agent.revisions[1].promotedAt).toBeNull();
    await asUser.expectOk(AUTO_PROMOTE, { id, autoPromote: false });
    expect((await asUser.expectOk(REVISIONS, { id })).agent.autoPromote).toBe(false);
  });

  it('is refused for an agent that does not exist, as NOT_FOUND', async () => {
    const refused = await asUser.expectError(AUTO_PROMOTE, { id: randomUUID(), autoPromote: true });
    expect(refused.code).toBe(ErrorCode.NotFound);
  });

  it('is refused for a run, whatever its roles', async () => {
    const { id } = await makeAgent('coding');
    const refused = await asRunOf({ roles: ADMIN_ROLES }).expectError(AUTO_PROMOTE, { id, autoPromote: true });
    expect(refused.code).toBe(ErrorCode.Forbidden);
  });
});
