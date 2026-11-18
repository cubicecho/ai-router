import { and, count, eq, isNull } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { Context } from '../core/context.ts';
import { INSTANCE_DEFAULTS } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import { parseOrThrow } from '../core/validation.ts';
import type { SnapshotServer } from '../db/snapshot.ts';
import { serverSecrets } from '../db/tables/server-secrets.ts';
import { servers } from '../db/tables/servers.ts';
import { workspaces } from '../db/tables/workspaces.ts';
import { objectType } from '../graphql/object-type.ts';
import { selectedId } from '../graphql/selected-id.ts';
import type { InstallServerRequest } from './api.ts';
import { refuseIfBuiltin } from './builtin.ts';
import { SECRET_LIMITS, secretInput } from './input.ts';
import { serverLoginStatus } from './oauth/service.ts';
import { TRANSPORT_STREAMABLE_HTTP } from './shapes.ts';

const TOOLS_SDL = parse(`
  "Whether the router holds a login for a remote server. Never the tokens or the client secret."
  type ServerLoginStatus {
    "A token the router can use now, or refresh."
    signedIn: Boolean!
    "When the access token runs out, if the login said."
    expiresAt: DateTime
    "Whether the router has a client at the server's login, registered or typed by hand."
    clientRegistered: Boolean!
    "Whether a hand-typed client secret is kept."
    hasClientSecret: Boolean!
    "The scope asked for when the server doesn't say."
    scope: String
    "The client id typed by hand, if any. Not a secret; its secret is never served."
    clientId: String
  }

  "The timeouts a server gets when it sets none of its own."
  type ServerDefaults {
    idleTimeoutMs: Int!
    callTimeoutMs: Int!
  }

  "Where to send a person to sign in to a server."
  type StartedServerLogin {
    "Already signed in: nothing to open."
    signedIn: Boolean!
    "The page to open in a popup. Null when already signed in."
    authorizationUrl: String
  }

  "One tool a server offers."
  type ServerTool {
    "The tool's name at the server. A run sees it as <server>__<name>."
    name: String!
    title: String
    description: String
    "The JSON Schema of its arguments."
    inputSchema: JSON
  }

  "A connection to a server: its base instance, or a workspace's."
  type ServerInstance {
    "Null for the base instance."
    workspaceId: UUID
    "stopped, starting, ready or failed."
    state: String!
    "Why it last failed."
    error: String
    "Calls waiting on it now."
    inFlight: Int!
  }

  "Something a registry entry can be installed as."
  type RegistryChoice {
    "What installServer's packageSelector takes."
    selector: String!
    "npm, pypi or streamable-http."
    kind: String!
    "The package, or the remote's address."
    identifier: String!
    version: String
  }

  "One server in a registry."
  type RegistryServer {
    "Its name in the registry, such as io.github.owner/repo."
    name: String!
    title: String
    description: String
    version: String
    choices: [RegistryChoice!]!
  }

  "A page of a registry's servers."
  type RegistryServerPage {
    servers: [RegistryServer!]!
    "Pass it back for the next page. Null on the last."
    nextCursor: String
  }

  "Where a server comes from."
  input ServerSourceInput {
    "registry, npm, pypi or manual."
    type: String!
    "A registry's name, for type registry."
    registry: String
    "The entry's name in the registry, for type registry."
    serverName: String
    "The package, for npm and pypi."
    package: String
    "A version; the latest when left out."
    version: String
  }

  "How a server added by hand is reached."
  input ServerTransportInput {
    "stdio or streamable-http."
    type: String!
    "The program, for stdio."
    command: String
    args: [String!]
    "The address, for streamable-http."
    url: String
  }

  "What to install."
  input InstallServerInput {
    "Derived from the package or entry when left out. Required for a manual server."
    name: String
    source: ServerSourceInput!
    "Which of a registry entry's packages or remotes: <index> or remote:<index>. The first npm, else pypi, else remote."
    packageSelector: String
    "For a manual server."
    transport: ServerTransportInput
    "Env values that aren't secret. Set secret ones with setServerSecret."
    env: JSON
    enabled: Boolean
  }

  "A client typed by hand, for a login that only knows clients it was told about."
  input ServerLoginClientInput {
    clientId: String!
    "Left out keeps the stored one while the client id stays the same; null removes it."
    clientSecret: String
    "The scope to ask for when the server doesn't say."
    scope: String
  }

  extend type Server {
    "Its login, for a remote server. Null for one the router starts. Select id with it."
    login: ServerLoginStatus
    "Its instances now, base first. Select id with it."
    instances: [ServerInstance!]!
  }

  extend type Query {
    "The timeouts a server gets when it sets none of its own."
    serverDefaults: ServerDefaults!
    "The tools a server offers, starting an instance if none runs. A workspaceId uses that workspace's settings."
    serverTools(id: UUID!, workspaceId: UUID): [ServerTool!]!
    "Searches a registry."
    registryServers(registryId: UUID!, search: String, cursor: String): RegistryServerPage!
  }

  extend type Mutation {
    "Installs a server from a registry, npm or PyPI, or adds one by hand. The install runs as the server's own user."
    installServer(input: InstallServerInput!): Server!
    "Stops a server, removes its folder and deletes it, with its secrets and workspace entries."
    deleteServer(id: UUID!): Boolean!
    "Stops one of a server's instances, so the next call starts it fresh."
    restartServer(id: UUID!, workspaceId: UUID): Boolean!
    "Calls one of a server's tools, to try it. Recorded in the activity."
    tryServerTool(id: UUID!, workspaceId: UUID, tool: String!, arguments: JSON): JSON
    "Starts signing in to a remote server. Open the answer's page in a popup."
    startServerLogin(serverId: UUID!): StartedServerLogin!
    "Forgets a remote server's tokens, keeping a hand-typed client."
    signOutServer(serverId: UUID!): Server!
    "Sets the client a remote server's login knows the router by. Null removes it. Admin only."
    setServerLoginClient(serverId: UUID!, client: ServerLoginClientInput): ServerLoginStatus!
    """
    Sets one of a server's secrets: an env var (kind "env") or a header (kind "header"). With a
    workspaceId, it is that workspace's override. A null or empty value clears it. The value is never
    served again. Admin only.
    """
    setServerSecret(serverId: UUID!, workspaceId: UUID, kind: String!, name: String!, value: String): Server!
  }
`);

/** What `setServerSecret` is called with. */
interface SetSecretArgs {
  serverId: string;
  workspaceId?: string | null;
  kind: string;
  name: string;
  value?: string | null;
}

/**
 * Finds a server in the snapshot by its id.
 *
 * @param ctx - The request.
 * @param id - The server.
 * @returns The server.
 * @throws NOT_FOUND when there is none.
 */
function serverById(ctx: Context, id: string): SnapshotServer {
  const found = [...ctx.snapshot.current().servers.values()].find((server) => server.id === id);
  if (found === undefined) {
    throw notFound('Server not found.');
  }
  return found;
}

/** Why the admin server has no login. */
const NO_LOGIN = 'it has no login';

/**
 * Reads a server's login as the API serves it.
 *
 * @param server - The server, from the snapshot.
 * @returns Its status, with the hand-typed client id, which is not a secret.
 */
function loginOf(server: SnapshotServer) {
  return { ...serverLoginStatus(server.oauth), clientId: server.oauth?.clientId ?? null };
}

/**
 * Reads a server's row as the API serves it.
 *
 * @param ctx - The request.
 * @param id - The server.
 * @returns The row, without its login.
 * @throws NOT_FOUND when there is none.
 */
async function servedServer(ctx: Context, id: string) {
  const [row] = await ctx.db.select().from(servers).where(eq(servers.id, id));
  if (row === undefined) {
    throw notFound('Server not found.');
  }
  const { oauth: _secret, ...served } = row;
  return served;
}

/**
 * Adds the tools fields CRUD can't express.
 *
 * @param schema - Schema to extend.
 * @returns The extended schema.
 */
export function applyToolsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, TOOLS_SDL);
  const queries = objectType(extended, 'Query').getFields();
  const mutations = objectType(extended, 'Mutation').getFields();
  const serverFields = objectType(extended, 'Server').getFields();

  serverFields.login.resolve = (parent: { id?: string }, _args: unknown, ctx: Context) => {
    const server = serverById(ctx, selectedId(parent, 'server', 'login'));
    return server.transport.type === TRANSPORT_STREAMABLE_HTTP ? loginOf(server) : null;
  };

  serverFields.instances.resolve = (parent: { id?: string }, _args: unknown, ctx: Context) =>
    ctx.tools.instanceStates(selectedId(parent, 'server', 'instances'));

  queries.serverDefaults.resolve = () => ({
    idleTimeoutMs: INSTANCE_DEFAULTS.idleTimeoutMs,
    callTimeoutMs: INSTANCE_DEFAULTS.callTimeoutMs,
  });

  queries.serverTools.resolve = (_parent: unknown, args: { id: string; workspaceId?: string | null }, ctx: Context) =>
    ctx.tools.listTools(args.id, args.workspaceId ?? null);

  queries.registryServers.resolve = (
    _parent: unknown,
    args: { registryId: string; search?: string | null; cursor?: string | null },
    ctx: Context,
  ) => ctx.tools.browse(args.registryId, args.search ?? null, args.cursor ?? null);

  mutations.installServer.resolve = (_parent: unknown, args: { input: InstallServerRequest }, ctx: Context) =>
    ctx.tools.install(args.input);

  mutations.deleteServer.resolve = async (_parent: unknown, args: { id: string }, ctx: Context) => {
    if ((await ctx.tools.remove(args.id)) === false) {
      throw notFound('Server not found.');
    }
    return true;
  };

  mutations.restartServer.resolve = async (
    _parent: unknown,
    args: { id: string; workspaceId?: string | null },
    ctx: Context,
  ) => {
    serverById(ctx, args.id);
    await ctx.tools.restart(args.id, args.workspaceId ?? null);
    return true;
  };

  mutations.tryServerTool.resolve = (
    _parent: unknown,
    args: { id: string; workspaceId?: string | null; tool: string; arguments?: unknown },
    ctx: Context,
  ) => {
    const toolArgs = args.arguments ?? {};
    if (isRecord(toolArgs) === false) {
      throw badInput('A tool takes its arguments as a JSON object.');
    }
    return ctx.tools.callTool(args.id, args.workspaceId ?? null, args.tool, toolArgs);
  };

  mutations.startServerLogin.resolve = (_parent: unknown, args: { serverId: string }, ctx: Context) => {
    refuseIfBuiltin(serverById(ctx, args.serverId), NO_LOGIN);
    return ctx.tools.logins.start(args.serverId);
  };

  mutations.signOutServer.resolve = async (_parent: unknown, args: { serverId: string }, ctx: Context) => {
    refuseIfBuiltin(serverById(ctx, args.serverId), NO_LOGIN);
    await ctx.tools.logins.signOut(args.serverId);
    return servedServer(ctx, args.serverId);
  };

  mutations.setServerLoginClient.resolve = async (
    _parent: unknown,
    args: {
      serverId: string;
      client?: { clientId: string; clientSecret?: string | null; scope?: string | null } | null;
    },
    ctx: Context,
  ) => {
    refuseIfBuiltin(serverById(ctx, args.serverId), NO_LOGIN);
    await ctx.tools.logins.setClient(args.serverId, args.client ?? null);
    return loginOf(serverById(ctx, args.serverId));
  };

  mutations.setServerSecret.resolve = async (_parent: unknown, args: SetSecretArgs, ctx: Context) => {
    const { kind, name, value } = parseOrThrow(secretInput, {
      kind: args.kind,
      name: args.name,
      value: args.value ?? null,
    });
    const workspaceId = args.workspaceId ?? null;
    const server = await ctx.db.transaction(async (tx) => {
      const [found] = await tx.select().from(servers).where(eq(servers.id, args.serverId)).for('update');
      if (found === undefined) {
        throw notFound('Server not found.');
      }
      refuseIfBuiltin(found, 'it takes no secrets');
      if (workspaceId !== null) {
        const [workspace] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
        if (workspace === undefined) {
          throw notFound('Workspace not found.');
        }
      }
      const sameKey = and(
        eq(serverSecrets.serverId, found.id),
        workspaceId === null ? isNull(serverSecrets.workspaceId) : eq(serverSecrets.workspaceId, workspaceId),
        eq(serverSecrets.kind, kind),
      );
      if (value === null || value === '') {
        await tx.delete(serverSecrets).where(and(sameKey, eq(serverSecrets.name, name)));
      } else {
        const [held] = await tx.select({ total: count() }).from(serverSecrets).where(sameKey);
        const [existing] = await tx
          .select({ id: serverSecrets.id })
          .from(serverSecrets)
          .where(and(sameKey, eq(serverSecrets.name, name)));
        if (existing === undefined && (held?.total ?? 0) >= SECRET_LIMITS[kind]) {
          throw badInput(`At most ${SECRET_LIMITS[kind]} secret ${kind} values.`);
        }
        await tx
          .insert(serverSecrets)
          .values({ serverId: found.id, workspaceId, kind, name, value })
          .onConflictDoUpdate({
            target: [serverSecrets.serverId, serverSecrets.workspaceId, serverSecrets.kind, serverSecrets.name],
            set: { value, updatedAt: new Date() },
          });
      }
      return found;
    });
    await ctx.snapshot.rebuild();
    const { oauth: _secret, ...served } = server;
    return served;
  };

  return extended;
}
