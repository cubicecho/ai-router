import { and, eq } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import { requireUser } from '../auth/caller.ts';
import { mintKey } from '../auth/keys.ts';
import type { Context } from '../core/context.ts';
import { notFound } from '../core/errors.ts';
import { parseOrThrow } from '../core/validation.ts';
import { MS_PER_DAY } from '../core/wire.ts';
import { workspaceAgentDisabledServers } from '../db/tables/workspace-agent-disabled-servers.ts';
import { workspaceAgents } from '../db/tables/workspace-agents.ts';
import { workspaceKeys } from '../db/tables/workspace-keys.ts';
import { workspaceServers } from '../db/tables/workspace-servers.ts';
import { workspaces } from '../db/tables/workspaces.ts';
import { objectType } from '../graphql/object-type.ts';
import { keyInput } from './input.ts';

const WORKSPACES_SDL = parse(`
  "A workspace key as it is made. The secret is in this answer and nowhere else, so show it to the person now."
  type CreatedWorkspaceKey {
    key: WorkspaceKey!
    "The whole key, for the app to send as \`Authorization: Bearer\` or \`x-api-key\`."
    secret: String!
  }

  extend type Mutation {
    "Makes a key for one of a workspace's apps. It works from the moment this answers."
    createWorkspaceKey(
      workspaceId: UUID!
      "What the app is, for people: phone, desktop."
      name: String!
      "Days until it stops working. Leave it out for a key that never expires."
      expiresInDays: Int
    ): CreatedWorkspaceKey!
    "Revokes a key. An app using it is refused from the next request. True when there was such a key."
    revokeWorkspaceKey(id: UUID!): Boolean!
    """
    Turns one of a workspace's servers on or off for one agent there. Every agent reaches every server of its
    workspace unless it is turned off for it. Takes effect from the next request, and answers whether it is on.
    """
    setWorkspaceAgentServerEnabled(
      "The workspace's entry for the agent."
      workspaceAgentId: UUID!
      "A server the workspace has."
      serverId: UUID!
      enabled: Boolean!
    ): Boolean!
  }
`);

/** What `setWorkspaceAgentServerEnabled` is given. */
interface SetAgentServerEnabledArgs {
  workspaceAgentId: string;
  serverId: string;
  enabled: boolean;
}

/** What `createWorkspaceKey` is given. */
interface CreateKeyArgs {
  workspaceId: string;
  name: string;
  expiresInDays?: number | null;
}

/**
 * Adds the workspace fields CRUD can't express: making and revoking keys, and turning a workspace's servers off for one of its agents.
 *
 * @param schema - Schema to extend.
 * @returns The extended schema.
 */
export function applyWorkspacesExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, WORKSPACES_SDL);
  const mutations = objectType(extended, 'Mutation').getFields();

  mutations.createWorkspaceKey.resolve = async (_parent: unknown, args: CreateKeyArgs, ctx: Context) => {
    const { userId } = requireUser(ctx.caller);
    const { name, expiresInDays } = parseOrThrow(keyInput, args);
    const [workspace] = await ctx.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, args.workspaceId));
    if (workspace === undefined) {
      throw notFound('Workspace not found.');
    }
    const { secret, hash, start } = mintKey();
    const expiresAt = expiresInDays == null ? null : new Date(Date.now() + expiresInDays * MS_PER_DAY);
    const [key] = await ctx.db
      .insert(workspaceKeys)
      .values({ workspaceId: workspace.id, name, start, hash, createdBy: userId, expiresAt })
      .returning();
    // Before answering, so the app can use the key at once.
    await ctx.snapshot.rebuild();
    return { key, secret };
  };

  mutations.revokeWorkspaceKey.resolve = async (_parent: unknown, args: { id: string }, ctx: Context) => {
    requireUser(ctx.caller);
    const deleted = await ctx.db
      .delete(workspaceKeys)
      .where(eq(workspaceKeys.id, args.id))
      .returning({ id: workspaceKeys.id });
    await ctx.snapshot.rebuild();
    return deleted.length > 0;
  };

  mutations.setWorkspaceAgentServerEnabled.resolve = async (
    _parent: unknown,
    args: SetAgentServerEnabledArgs,
    ctx: Context,
  ) => {
    requireUser(ctx.caller);
    const { workspaceAgentId, serverId, enabled } = args;
    await ctx.db.transaction(async (tx) => {
      const [entry] = await tx
        .select({ id: workspaceAgents.id })
        .from(workspaceAgents)
        .innerJoin(
          workspaceServers,
          and(eq(workspaceServers.workspaceId, workspaceAgents.workspaceId), eq(workspaceServers.serverId, serverId)),
        )
        .where(eq(workspaceAgents.id, workspaceAgentId));
      if (entry === undefined) {
        throw notFound('That workspace does not run that agent, or does not have that server.');
      }
      const isOff = and(
        eq(workspaceAgentDisabledServers.workspaceAgentId, workspaceAgentId),
        eq(workspaceAgentDisabledServers.serverId, serverId),
      );
      if (enabled) {
        await tx.delete(workspaceAgentDisabledServers).where(isOff);
      } else {
        await tx.insert(workspaceAgentDisabledServers).values({ workspaceAgentId, serverId }).onConflictDoNothing();
      }
    });
    // Before answering, so the next request reaches what was set.
    await ctx.snapshot.rebuild();
    return enabled;
  };

  return extended;
}
