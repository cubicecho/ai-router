import { and, desc, eq } from 'drizzle-orm';
import { extendSchema, GraphQLError, type GraphQLSchema, parse } from 'graphql';
import { z } from 'zod';
import type { Context } from '../core/context.ts';
import { AGENT_CONFIG_DEFAULTS } from '../core/defaults.ts';
import { badInput, ErrorCode, forbidden, notFound } from '../core/errors.ts';
import { parseOrThrow } from '../core/validation.ts';
import type { Transaction } from '../db/client.ts';
import { agentRevisions } from '../db/tables/agent-revisions.ts';
import { type AgentRow, agents } from '../db/tables/agents.ts';
import { objectType } from '../graphql/object-type.ts';
import { checkDocument, type DocumentCheck } from './document.ts';
import { isDraft, mayDiscard, type Saver, saverOf, savesAsDraft } from './revisions.ts';

const AGENTS_SDL = parse(`
  "What a document check found, before anything is saved."
  type AgentCheck {
    "Why it can't be saved. Empty when it can."
    errors: [String!]!
    "What is worth a look. Never a reason it can't be saved."
    warnings: [String!]!
  }

  extend type Query {
    "Checks an agent document without saving it. With an id, as a new revision of that agent."
    checkAgent(document: JSON!, id: UUID): AgentCheck!
  }

  extend type Mutation {
    "Adds an agent from a cubicecho.agent/1 document, named by its id. Its first revision goes live, whoever saves it."
    createAgent(document: JSON!, message: String): Agent!
    """
    Saves a new revision of an agent. A person's save goes live at once. A run's save is a draft until a person
    promotes it, unless the agent has auto-promote on. basedOn is the revision the save started from, a revision of
    the same agent; left out, it is the live one.
    """
    saveAgent(id: UUID!, document: JSON!, message: String, basedOn: UUID): AgentRevision!
    "Makes a revision live: a draft goes live, and an older one rolls the agent back. Only a person promotes."
    promoteRevision(id: UUID!): Agent!
    """
    Deletes a draft. A revision that is live or has ever been live stays in the history. A run may discard only the
    drafts its own agent saved for its workspace.
    """
    discardRevision(id: UUID!): Agent!
    """
    Turns auto-promote on or off for an agent. On, a run's saves go live without review. Turning it on leaves the
    drafts already saved as they are. Only a person sets it.
    """
    setAgentAutoPromote(id: UUID!, autoPromote: Boolean!): Agent!
  }
`);

/** A revision's message, as a save states it. */
const messageInput = z
  .string()
  .trim()
  .max(AGENT_CONFIG_DEFAULTS.maxMessageLength, 'That message is too long.')
  .nullable();

/**
 * Refuses a document with every reason at once, so a person fixes it in one go.
 *
 * @param check - What the check found.
 * @returns The error, coded BAD_USER_INPUT, with the reasons and warnings in its extensions.
 */
function refusal(check: DocumentCheck): GraphQLError {
  return new GraphQLError(check.errors.join('\n'), {
    extensions: { code: ErrorCode.BadUserInput, errors: check.errors, warnings: check.warnings },
  });
}

/**
 * Reads the revision a save says it started from.
 *
 * @param tx - The transaction.
 * @param agent - The agent saved to.
 * @param basedOn - The revision named, or null or absent for the live one.
 * @returns The revision's id, or null when nothing is live and none was named.
 * @throws BAD_USER_INPUT when the revision named is not one of this agent's.
 */
async function basedOnOf(tx: Transaction, agent: AgentRow, basedOn: string | null | undefined): Promise<string | null> {
  if (basedOn === null || basedOn === undefined) {
    return agent.liveRevisionId;
  }
  const [revision] = await tx
    .select({ id: agentRevisions.id })
    .from(agentRevisions)
    .where(and(eq(agentRevisions.id, basedOn), eq(agentRevisions.agentId, agent.id)));
  if (revision === undefined) {
    throw badInput(`basedOn: that is not a revision of agent "${agent.name}".`);
  }
  return revision.id;
}

/**
 * Loads an agent by id, locked for the rest of the transaction.
 *
 * @param tx - The transaction.
 * @param id - The agent's id.
 * @returns The row.
 * @throws NOT_FOUND when there is no such agent.
 */
async function lockedAgent(tx: Transaction, id: string): Promise<AgentRow> {
  const [agent] = await tx.select().from(agents).where(eq(agents.id, id)).for('update');
  if (agent === undefined) {
    throw notFound('Agent not found.');
  }
  return agent;
}

/** What a new revision holds beyond its document. */
interface NewRevision {
  /** What changed, in the saver's words. */
  message: string;
  /** Who saved it. */
  saver: Saver;
  /** The revision it started from. */
  basedOnId: string | null;
  /** Whether it goes live now, or stays a draft. */
  goesLive: boolean;
}

/**
 * Adds a revision, live or as a draft, inside the caller's transaction.
 *
 * @param tx - The transaction, holding the agent's row locked.
 * @param agent - The agent.
 * @param check - The passed check: what to store, and its warnings.
 * @param revision - Its message, saver, starting point, and whether it goes live.
 * @returns The revision.
 */
async function addRevision(tx: Transaction, agent: AgentRow, check: DocumentCheck, revision: NewRevision) {
  const [latest] = await tx
    .select({ number: agentRevisions.number })
    .from(agentRevisions)
    .where(eq(agentRevisions.agentId, agent.id))
    .orderBy(desc(agentRevisions.number))
    .limit(1);
  const [added] = await tx
    .insert(agentRevisions)
    .values({
      agentId: agent.id,
      number: (latest?.number ?? 0) + 1,
      document: check.stored ?? {},
      warnings: check.warnings,
      message: revision.message,
      ...revision.saver,
      basedOnId: revision.basedOnId,
      promotedAt: revision.goesLive ? new Date() : null,
    })
    .returning();
  if (added === undefined) {
    throw new Error('The revision insert returned no row.');
  }
  if (revision.goesLive) {
    await tx.update(agents).set({ liveRevisionId: added.id }).where(eq(agents.id, agent.id));
  }
  return added;
}

/**
 * Adds the agents fields CRUD can't express: saving through the document check, revisions, drafts and promotion.
 *
 * @param schema - Schema to extend.
 * @returns The extended schema.
 */
export function applyAgentsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, AGENTS_SDL);
  const queries = objectType(extended, 'Query').getFields();
  const mutations = objectType(extended, 'Mutation').getFields();

  queries.checkAgent.resolve = async (
    _parent: unknown,
    args: { document: unknown; id?: string | null },
    ctx: Context,
  ) => {
    let expectedName: string | undefined;
    if (args.id !== null && args.id !== undefined) {
      const [agent] = await ctx.db.select({ name: agents.name }).from(agents).where(eq(agents.id, args.id));
      if (agent === undefined) {
        throw notFound('Agent not found.');
      }
      expectedName = agent.name;
    }
    const { errors, warnings } = checkDocument(args.document, ctx.snapshot.current(), expectedName);
    return { errors, warnings };
  };

  mutations.createAgent.resolve = async (
    _parent: unknown,
    args: { document: unknown; message?: string | null },
    ctx: Context,
  ) => {
    const message = parseOrThrow(messageInput, args.message ?? null) ?? '';
    const check = checkDocument(args.document, ctx.snapshot.current());
    if (check.errors.length > 0 || check.name === null) {
      throw refusal(check);
    }
    const name = check.name;
    const created = await ctx.db.transaction(async (tx) => {
      const [taken] = await tx.select({ id: agents.id }).from(agents).where(eq(agents.name, name));
      if (taken !== undefined) {
        throw refusal({
          ...check,
          errors: [`id: an agent named "${name}" already exists. Save a new revision of it instead.`],
        });
      }
      const [agent] = await tx.insert(agents).values({ name }).returning();
      if (agent === undefined) {
        throw new Error('The agent insert returned no row.');
      }
      // Nothing is live yet to protect, so the first revision goes live whoever saves it.
      const revision = await addRevision(tx, agent, check, {
        message,
        saver: saverOf(ctx.caller),
        basedOnId: null,
        goesLive: true,
      });
      return { ...agent, liveRevisionId: revision.id };
    });
    await ctx.snapshot.rebuild();
    return created;
  };

  mutations.saveAgent.resolve = async (
    _parent: unknown,
    args: { id: string; document: unknown; message?: string | null; basedOn?: string | null },
    ctx: Context,
  ) => {
    const message = parseOrThrow(messageInput, args.message ?? null) ?? '';
    const revision = await ctx.db.transaction(async (tx) => {
      const agent = await lockedAgent(tx, args.id);
      const check = checkDocument(args.document, ctx.snapshot.current(), agent.name);
      if (check.errors.length > 0) {
        throw refusal(check);
      }
      return addRevision(tx, agent, check, {
        message,
        saver: saverOf(ctx.caller),
        basedOnId: await basedOnOf(tx, agent, args.basedOn),
        goesLive: savesAsDraft(ctx.caller, agent) === false,
      });
    });
    // A draft changes nothing that routes.
    if (revision.promotedAt !== null) {
      await ctx.snapshot.rebuild();
    }
    return revision;
  };

  mutations.promoteRevision.resolve = async (_parent: unknown, args: { id: string }, ctx: Context) => {
    const agent = await ctx.db.transaction(async (tx) => {
      const [revision] = await tx.select().from(agentRevisions).where(eq(agentRevisions.id, args.id));
      if (revision === undefined) {
        throw notFound('Revision not found.');
      }
      const [locked] = await tx.select().from(agents).where(eq(agents.id, revision.agentId)).for('update');
      if (locked === undefined) {
        throw notFound('Agent not found.');
      }
      await tx
        .update(agentRevisions)
        .set({ promotedAt: new Date() })
        .where(and(eq(agentRevisions.id, revision.id), eq(agentRevisions.agentId, locked.id)));
      const [promoted] = await tx
        .update(agents)
        .set({ liveRevisionId: revision.id })
        .where(eq(agents.id, locked.id))
        .returning();
      return promoted ?? locked;
    });
    await ctx.snapshot.rebuild();
    return agent;
  };

  mutations.discardRevision.resolve = async (_parent: unknown, args: { id: string }, ctx: Context) =>
    ctx.db.transaction(async (tx) => {
      const [revision] = await tx.select().from(agentRevisions).where(eq(agentRevisions.id, args.id));
      if (revision === undefined) {
        throw notFound('Revision not found.');
      }
      const agent = await lockedAgent(tx, revision.agentId);
      // Any caller who may discard can read the agents, so a draft it may not touch is refused, not hidden.
      if (mayDiscard(ctx.caller, revision) === false) {
        throw forbidden('A run can discard only the drafts its own agent saved for its workspace.');
      }
      if (isDraft(revision, agent.liveRevisionId) === false) {
        throw badInput(
          `Revision ${revision.number} has been live, so it stays in the history. Only a draft can be discarded.`,
        );
      }
      await tx.delete(agentRevisions).where(eq(agentRevisions.id, revision.id));
      return agent;
    });

  mutations.setAgentAutoPromote.resolve = async (
    _parent: unknown,
    args: { id: string; autoPromote: boolean },
    ctx: Context,
  ) => {
    const [agent] = await ctx.db
      .update(agents)
      .set({ autoPromote: args.autoPromote })
      .where(eq(agents.id, args.id))
      .returning();
    if (agent === undefined) {
      throw notFound('Agent not found.');
    }
    return agent;
  };

  return extended;
}
