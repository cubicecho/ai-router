import { describe, expect, it } from 'vitest';
import { RevisionStanding, standingOf, whoOf } from '../../web/agents/revisions.ts';

// The agent page names who saved each revision, and sorts drafts from the history by where each stands.

describe('who saved a revision', () => {
  const nobody = { creator: null, savedByWorkspace: null, savedByAgent: null };

  it('is the person, by name or else email', () => {
    expect(whoOf({ ...nobody, creator: { name: 'Ben', email: 'ben@example.com' } })).toBe('Ben');
    expect(whoOf({ ...nobody, creator: { name: null, email: 'ben@example.com' } })).toBe('ben@example.com');
  });

  it('is the workspace and agent of a run', () => {
    expect(whoOf({ ...nobody, savedByWorkspace: { name: 'task-server' }, savedByAgent: { name: 'author' } })).toBe(
      'workspace task-server · agent author',
    );
    expect(whoOf({ ...nobody, savedByAgent: { name: 'author' } })).toBe('workspace removed · agent author');
  });

  it('says so when whoever saved it is gone', () => {
    expect(whoOf(nobody)).toBe('Someone since removed');
  });
});

describe('where a revision stands', () => {
  const promotedAt = '2026-11-18T09:00:00Z';

  it('is live, retired or a draft', () => {
    expect(standingOf({ id: 'r1', promotedAt }, 'r1')).toBe(RevisionStanding.Live);
    expect(standingOf({ id: 'r2', promotedAt }, 'r1')).toBe(RevisionStanding.Retired);
    expect(standingOf({ id: 'r3', promotedAt: null }, 'r1')).toBe(RevisionStanding.Draft);
    expect(standingOf({ id: 'r3', promotedAt: null }, null)).toBe(RevisionStanding.Draft);
  });
});
