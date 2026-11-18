import { CALLER_RUN, CALLER_USER, type Caller } from '../core/context.ts';
import type { AgentRevision } from '../db/tables/agent-revisions.ts';
import type { AgentRow } from '../db/tables/agents.ts';

// Who a revision is from, and what a caller may do with drafts. Kept apart from the resolvers so the rules for a run
// can be tested without the permission map that lets a run reach them.

/** Who saved a revision, as its columns record it. */
export interface Saver {
  /** The person. */
  createdBy: string | null;
  /** The workspace whose agent run saved it. */
  savedByWorkspaceId: string | null;
  /** The agent whose run saved it. */
  savedByAgentId: string | null;
}

/**
 * Reads who is saving, for the revision's columns.
 *
 * @param caller - The request's caller.
 * @returns A person's id, or a run's workspace and agent. Anyone else is recorded as no one.
 */
export function saverOf(caller: Caller | null): Saver {
  if (caller?.kind === CALLER_USER) {
    return { createdBy: caller.userId, savedByWorkspaceId: null, savedByAgentId: null };
  }
  if (caller?.kind === CALLER_RUN) {
    return { createdBy: null, savedByWorkspaceId: caller.workspaceId, savedByAgentId: caller.agentId };
  }
  return { createdBy: null, savedByWorkspaceId: null, savedByAgentId: null };
}

/**
 * Whether a save of an existing agent stays a draft rather than going live.
 *
 * @param caller - Who is saving.
 * @param agent - The agent saved to.
 * @returns false for a person's save, and for any save of an agent with auto-promote on; true otherwise.
 */
export function savesAsDraft(caller: Caller | null, agent: Pick<AgentRow, 'autoPromote'>): boolean {
  const isPerson = caller?.kind === CALLER_USER;
  return isPerson === false && agent.autoPromote === false;
}

/**
 * Whether a revision is a draft: never promoted, and not live. Every live revision has been promoted, so this is
 * `promotedAt` alone, with the live check kept so the rule reads as the domain model states it.
 *
 * @param revision - The revision.
 * @param liveRevisionId - Its agent's live revision, or null.
 * @returns true for a draft.
 */
export function isDraft(revision: Pick<AgentRevision, 'id' | 'promotedAt'>, liveRevisionId: string | null): boolean {
  return revision.promotedAt === null && revision.id !== liveRevisionId;
}

/**
 * Whether a caller may discard a draft. A person may discard any. A run may discard only the drafts its own agent
 * saved for its own workspace.
 *
 * @param caller - Who is asking.
 * @param revision - The draft.
 * @returns true when the caller may.
 */
export function mayDiscard(
  caller: Caller | null,
  revision: Pick<AgentRevision, 'savedByWorkspaceId' | 'savedByAgentId'>,
): boolean {
  if (caller?.kind === CALLER_USER) {
    return true;
  }
  if (caller?.kind === CALLER_RUN) {
    return revision.savedByWorkspaceId === caller.workspaceId && revision.savedByAgentId === caller.agentId;
  }
  return false;
}
