// Who saved a revision and where it stands, as the agent page shows them.

/** Who saved a revision, as the history reads it: a person, or an agent's run for a workspace. */
export interface RevisionSaver {
  /** The person, or null for a run's save and once their account is gone. */
  creator: { name: string | null; email: string } | null;
  /** The workspace whose run saved it, or null for a person's save and once it is gone. */
  savedByWorkspace: { name: string } | null;
  /** The agent whose run saved it, or null for a person's save and once it is gone. */
  savedByAgent: { name: string } | null;
}

/** What stands in for a workspace or agent deleted since it saved a revision. */
const REMOVED = 'removed';

/**
 * Names who saved a revision.
 *
 * @param revision - The revision's saver.
 * @returns The person's name or email, "workspace X · agent Y" for a run, or "Someone since removed".
 */
export function whoOf({ creator, savedByWorkspace, savedByAgent }: RevisionSaver): string {
  if (creator !== null) {
    return creator.name ?? creator.email;
  }
  const isRunSave = savedByWorkspace !== null || savedByAgent !== null;
  if (isRunSave) {
    return `workspace ${savedByWorkspace?.name ?? REMOVED} · agent ${savedByAgent?.name ?? REMOVED}`;
  }
  return 'Someone since removed';
}

/** Where a revision stands: the one live, live once and since replaced, or a draft never live. */
export const RevisionStanding = { Live: 'live', Retired: 'retired', Draft: 'draft' } as const;
export type RevisionStanding = (typeof RevisionStanding)[keyof typeof RevisionStanding];

/**
 * Says where a revision stands. Every live revision has been promoted, so one never promoted is a draft.
 *
 * @param revision - The revision.
 * @param liveRevisionId - Its agent's live revision, or null.
 * @returns Live, retired or draft.
 */
export function standingOf(
  revision: { id: string; promotedAt: string | null },
  liveRevisionId: string | null,
): RevisionStanding {
  if (revision.id === liveRevisionId) {
    return RevisionStanding.Live;
  }
  return revision.promotedAt === null ? RevisionStanding.Draft : RevisionStanding.Retired;
}
