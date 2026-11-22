import { describe, expect, it } from 'vitest';
import { isDraft, mayDiscard, saverOf, savesAsDraft } from '../../server/agents/revisions.ts';
import { AdminRole } from '../../server/core/admin-roles.ts';
import { CALLER_RUN, CALLER_USER, CALLER_WORKSPACE, type Caller } from '../../server/core/context.ts';
import { Role } from '../../server/db/tables/users.ts';

const person: Caller = { kind: CALLER_USER, userId: 'user-1', role: Role.User };
const run: Caller = {
  kind: CALLER_RUN,
  runId: 'run-1',
  workspaceId: 'workspace-1',
  agentId: 'author-1',
  roles: [AdminRole.AgentsManage],
  depth: 1,
};
const key: Caller = { kind: CALLER_WORKSPACE, workspaceId: 'workspace-1', keyId: 'key-1' };

describe('who a save is recorded as', () => {
  it('is the person for a person', () => {
    expect(saverOf(person)).toEqual({ createdBy: 'user-1', savedByWorkspaceId: null, savedByAgentId: null });
  });

  it('is the workspace and agent for a run, with no person', () => {
    expect(saverOf(run)).toEqual({ createdBy: null, savedByWorkspaceId: 'workspace-1', savedByAgentId: 'author-1' });
  });

  it('is no one for anyone else', () => {
    const nobody = { createdBy: null, savedByWorkspaceId: null, savedByAgentId: null };
    expect(saverOf(key)).toEqual(nobody);
    expect(saverOf(null)).toEqual(nobody);
  });
});

describe('whether a save stays a draft', () => {
  it('never does for a person', () => {
    expect(savesAsDraft(person, { autoPromote: false })).toBe(false);
  });

  it('does for a run, unless the agent auto-promotes', () => {
    expect(savesAsDraft(run, { autoPromote: false })).toBe(true);
    expect(savesAsDraft(run, { autoPromote: true })).toBe(false);
  });

  it('does for anyone who is not a person', () => {
    expect(savesAsDraft(key, { autoPromote: false })).toBe(true);
    expect(savesAsDraft(null, { autoPromote: false })).toBe(true);
  });
});

describe('what a draft is', () => {
  const promotedAt = new Date();

  it('is a revision never promoted and not live', () => {
    expect(isDraft({ id: 'r2', promotedAt: null }, 'r1')).toBe(true);
    expect(isDraft({ id: 'r2', promotedAt: null }, null)).toBe(true);
  });

  it('is never a live or retired revision', () => {
    expect(isDraft({ id: 'r1', promotedAt }, 'r1')).toBe(false);
    expect(isDraft({ id: 'r2', promotedAt }, 'r1')).toBe(false);
  });
});

describe('who may discard a draft', () => {
  const own = { savedByWorkspaceId: 'workspace-1', savedByAgentId: 'author-1' };

  it('is any person, whoever saved it', () => {
    expect(mayDiscard(person, own)).toBe(true);
    expect(mayDiscard(person, { savedByWorkspaceId: null, savedByAgentId: null })).toBe(true);
  });

  it('is a run, for the drafts its own agent saved for its own workspace', () => {
    expect(mayDiscard(run, own)).toBe(true);
  });

  it.each([
    ['another workspace’s', { savedByWorkspaceId: 'workspace-2', savedByAgentId: 'author-1' }],
    ['another agent’s', { savedByWorkspaceId: 'workspace-1', savedByAgentId: 'author-2' }],
    ['a person’s', { savedByWorkspaceId: null, savedByAgentId: null }],
  ])('is not a run, for %s draft', (_label, revision) => {
    expect(mayDiscard(run, revision)).toBe(false);
  });

  it('is no one else', () => {
    expect(mayDiscard(key, own)).toBe(false);
    expect(mayDiscard(null, own)).toBe(false);
  });
});
