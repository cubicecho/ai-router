import { and, eq, exists, inArray, lt, not, sql } from 'drizzle-orm';
import { CONVERSATION_DEFAULTS } from '../core/defaults.ts';
import { MS_PER_HOUR } from '../core/wire.ts';
import type { DB } from '../db/client.ts';
import type { SnapshotAgent } from '../db/snapshot.ts';
import { conversations } from '../db/tables/conversations.ts';
import { RunStatus, runs } from '../db/tables/runs.ts';
import { type ChatMessage, RequestRefusal, type RunRequest } from './request.ts';

/** The header an app names a conversation in. */
export const CONVERSATION_HEADER = 'X-Conversation-Id';
/** What an `X-Conversation-Id` may hold: printable ASCII, no spaces. */
const KEY_PATTERN = /^[\x21-\x7e]+$/;
/** The statuses of a run a conversation is busy with. */
const GOING: RunStatus[] = [RunStatus.Running, RunStatus.Waiting];

/** A conversation as a request uses it. */
export interface Conversation {
  id: string;
  /** The app's name for it. */
  key: string;
  /** The transcript so far, without the system prompt. */
  messages: ChatMessage[];
  /** The host text of its latest run. */
  hostText: string | null;
}

/**
 * Reads a key an app names something by in a header: a conversation, or a session.
 *
 * @param header - The header, for the refusal.
 * @param value - Its value, if sent.
 * @returns The key, or null when it wasn't sent.
 * @throws {@link RequestRefusal} For an empty, too long or unprintable key.
 */
export function readKeyHeader(header: string, value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const key = value.trim();
  const isUsable = key.length <= CONVERSATION_DEFAULTS.maxIdLength && KEY_PATTERN.test(key);
  if (isUsable === false) {
    throw new RequestRefusal(
      header,
      `${header}: send 1 to ${CONVERSATION_DEFAULTS.maxIdLength} printable characters, without spaces.`,
    );
  }
  return key;
}

/**
 * Reads the conversation a request names.
 *
 * @param value - The `X-Conversation-Id` header, if sent.
 * @returns The app's name for it, or null when the request is stateless.
 * @throws {@link RequestRefusal} For an empty, too long or unprintable id.
 */
export function readConversationKey(value: string | undefined): string | null {
  return readKeyHeader(CONVERSATION_HEADER, value);
}

/**
 * When a conversation used now is next deleted, if nothing uses it again.
 *
 * @param now - Now.
 * @returns The time.
 */
function nextExpiry(now: Date): Date {
  return new Date(now.getTime() + CONVERSATION_DEFAULTS.idleHours * MS_PER_HOUR);
}

/**
 * Opens a workspace's conversation, starting it if it is new or has expired, and moves its expiry on.
 *
 * @param db - The database.
 * @param workspaceId - The key's workspace, whose conversations its keys share.
 * @param agent - The agent the request names.
 * @param key - The app's name for the conversation.
 * @param now - Now.
 * @returns The conversation.
 * @throws {@link RequestRefusal} When it is with another agent.
 */
export async function openConversation(
  db: DB,
  workspaceId: string,
  agent: SnapshotAgent,
  key: string,
  now: Date,
): Promise<Conversation> {
  const expiresAt = nextExpiry(now);
  await db
    .insert(conversations)
    .values({ workspaceId, key, agentId: agent.id, agentName: agent.name, expiresAt })
    .onConflictDoNothing({ target: [conversations.workspaceId, conversations.key] });
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.key, key)));
  if (row === undefined) {
    throw new Error(`Conversation "${key}" was neither found nor started.`);
  }
  // One that expired and is not yet pruned starts again, unless a run of it is still going.
  const isBusy = (await busyRun(db, row.id)) !== null;
  const hasExpired = row.expiresAt.getTime() <= now.getTime() && isBusy === false;
  if (hasExpired) {
    await db
      .update(conversations)
      .set({ agentId: agent.id, agentName: agent.name, messages: [], hostText: null, updatedAt: now, expiresAt })
      .where(eq(conversations.id, row.id));
    return { id: row.id, key, messages: [], hostText: null };
  }
  if (row.agentId !== agent.id) {
    throw new RequestRefusal(
      CONVERSATION_HEADER,
      `${CONVERSATION_HEADER}: conversation "${key}" is with agent "${row.agentName}". Name a new conversation for another agent.`,
    );
  }
  await db.update(conversations).set({ updatedAt: now, expiresAt }).where(eq(conversations.id, row.id));
  return { id: row.id, key, messages: row.messages, hostText: row.hostText };
}

/**
 * Finds the run a conversation is busy with.
 *
 * @param db - The database.
 * @param conversationId - The conversation.
 * @returns The run that is running or waiting, or null.
 */
export async function busyRun(db: DB, conversationId: string): Promise<{ id: string; status: RunStatus } | null> {
  const [row] = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(and(eq(runs.conversationId, conversationId), inArray(runs.status, GOING)));
  return row ?? null;
}

/**
 * Puts a conversation's history in front of a request's new messages.
 *
 * @param request - The request, which may send only new messages once the conversation has history.
 * @param conversation - The conversation.
 * @returns The request with the whole transcript, and the conversation's host text when it sends none.
 * @throws {@link RequestRefusal} When the request sends assistant or tool messages to a conversation that has
 * history: the router can't tell history sent again from new turns, so it refuses rather than guess.
 */
export function withHistory(request: RunRequest, conversation: Conversation): RunRequest {
  if (conversation.messages.length === 0) {
    return request;
  }
  const isResent = request.messages.some((message) => message.role === 'assistant' || message.role === 'tool');
  if (isResent) {
    throw new RequestRefusal(
      'messages',
      `messages: conversation "${conversation.key}" keeps its own history, so send only what is new: user messages, and system messages to change the instructions. Without ${CONVERSATION_HEADER}, send the whole conversation instead.`,
    );
  }
  return {
    ...request,
    messages: [...conversation.messages, ...request.messages],
    hostText: request.hostText ?? conversation.hostText,
  };
}

/**
 * Keeps a run's transcript as its conversation's history.
 *
 * @param db - The database.
 * @param conversationId - The conversation.
 * @param messages - The run's whole transcript.
 * @param hostText - The run's host text.
 * @param now - Now.
 */
export async function saveConversation(
  db: DB,
  conversationId: string,
  messages: ChatMessage[],
  hostText: string | null,
  now: Date,
): Promise<void> {
  await db
    .update(conversations)
    .set({ messages, hostText, updatedAt: now, expiresAt: nextExpiry(now) })
    .where(eq(conversations.id, conversationId));
}

/**
 * Moves a conversation's expiry on, for a run that ended without an answer to keep or waits.
 *
 * @param db - The database.
 * @param conversationId - The conversation.
 * @param now - Now.
 */
export async function touchConversation(db: DB, conversationId: string, now: Date): Promise<void> {
  await db
    .update(conversations)
    .set({ updatedAt: now, expiresAt: nextExpiry(now) })
    .where(eq(conversations.id, conversationId));
}

/**
 * Deletes conversations idle past their time, unless a run of one is still going or waiting.
 *
 * @param db - The database.
 * @param now - Now.
 */
export async function pruneConversations(db: DB, now: Date): Promise<void> {
  const going = db
    .select({ one: sql`1` })
    .from(runs)
    .where(and(eq(runs.conversationId, conversations.id), inArray(runs.status, GOING)));
  await db.delete(conversations).where(and(lt(conversations.expiresAt, now), not(exists(going))));
}
