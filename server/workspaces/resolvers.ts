import { eq, inArray } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import { requireUser } from '../auth/caller.ts';
import { mintKey } from '../auth/keys.ts';
import type { Context } from '../core/context.ts';
import { badInput, notFound } from '../core/errors.ts';
import { parseOrThrow } from '../core/validation.ts';
import { MS_PER_DAY } from '../core/wire.ts';
import { servers } from '../db/tables/servers.ts';
import { workspaceAgentServers } from '../db/tables/workspace-agent-servers.ts';
import { workspaceAgents } from '../db/tables/workspace-agents.ts';
import { workspaceKeys } from '../db/tables/workspace-keys.ts';
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
    Sets which MCP servers an agent may use in a workspace, replacing what was set. Its runs there reach exactly
    these, and none when the list is empty, from the next request. Answers the servers now granted.
    """
    setWorkspaceAgentServers(
      "The workspace's entry for the agent."
      workspaceAgentId: UUID!
      serverIds: [UUID!]!
    ): [UUID!]!
  }
`);

/** What `setWorkspaceAgentServers` is given. */
interface SetAgentServersArgs {
  workspaceAgentId: string;
  serverIds: readonly string[];
}

/** What `createWorkspaceKey` is given. */
interface CreateKeyArgs {
  workspaceId: string;
  name: string;
  expiresInDays?: number | null;
}

/**
 * Adds the workspace fields CRUD can't express: making and revoking keys, and which servers an agent may use.
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

  mutations.setWorkspaceAgentServers.resolve = async (_parent: unknown, args: SetAgentServersArgs, ctx: Context) => {
    requireUser(ctx.caller);
    const serverIds = [...new Set(args.serverIds)];
    const granted = await ctx.db.transaction(async (tx) => {
      const [entry] = await tx
        .select({ id: workspaceAgents.id })
        .from(workspaceAgents)
        .where(eq(workspaceAgents.id, args.workspaceAgentId));
      if (entry === undefined) {
        throw notFound('That workspace does not run that agent.');
      }
      const known =
        serverIds.length === 0
          ? []
          : await tx.select({ id: servers.id }).from(servers).where(inArray(servers.id, serverIds));
      const hasUnknown = known.length < serverIds.length;
      if (hasUnknown) {
        throw badInput('One of those servers does not exist.');
      }
      await tx.delete(workspaceAgentServers).where(eq(workspaceAgentServers.workspaceAgentId, entry.id));
      if (serverIds.length > 0) {
        await tx
          .insert(workspaceAgentServers)
          .values(serverIds.map((serverId) => ({ workspaceAgentId: entry.id, serverId })));
      }
      return serverIds;
    });
    // Before answering, so the next request reaches what was set.
    await ctx.snapshot.rebuild();
    return granted;
  };

  return extended;
}
