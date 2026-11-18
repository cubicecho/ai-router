import {
  connectServer,
  createServerFactory,
  MutationHints,
  NullBranches,
  OperationKind,
  type ServerFactory,
} from '@cubicecho/graphql-mcp';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { type GraphQLInputField, type GraphQLInputObjectType, type GraphQLSchema, getNamedType } from 'graphql';
import type { AdminRole } from '../core/admin-roles.ts';
import { version } from '../core/config.ts';
import { CALLER_RUN, type RunCaller } from '../core/context.ts';
import { MCP_DEFAULTS } from '../core/defaults.ts';
import { forbidden } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import { abilityForRoles, canReachField } from '../graphql/abilities.ts';
import type { RunContextFactory } from '../graphql/handler.ts';
import { type BuiltinConnector, readRunMeta } from '../tools/builtin.ts';
import { RESERVED_SERVER_NAME, type ResolvedServer, TRANSPORT_BUILTIN } from '../tools/shapes.ts';

/**
 * Root fields a role reaches but the listing leaves out: the aggregate and group-by forms of each table, which the list
 * tools' filters answer for an agent, and which would put the listing past `MCP_DEFAULTS.maxToolListBytes`.
 */
export const UNLISTED_FIELDS: readonly string[] = Object.freeze(['*Aggregate', '*GroupBy']);

/** What a call that names no run is told: a person manages the router in the UI. */
const RUNS_ONLY =
  "The admin server's tools are for agent runs that name it. A person does the same in the router's UI.";

/**
 * Orientation for generated fields, which only describe themselves as "the `agents` query". Keyed by tool name. Prose
 * names other tools by their MCP names.
 */
const HINTS: Readonly<Record<string, string>> = {
  agents:
    "Every agent on the router: its name, and the id of its live revision. A revision's document is read with `agent_revision`.",
  agent_revisions:
    'Saved versions of agents, each a cubicecho.agent/1 document, with what the saver said changed and any warnings.',
  check_agent: 'Checks an agent document without saving it, and lists its warnings. Call it before `save_agent`.',
  create_agent: 'Adds an agent from a cubicecho.agent/1 document.',
  save_agent:
    "Saves a new revision of an agent. A run's save is a draft until a person promotes it, unless the agent has auto-promote.",
  runs: 'The runs your own workspace started: status, error, timings and token counts. Filter by status: `where: { status: { eq: "failed" } }`.',
  servers: 'Every MCP server on the router: how it is reached, and whether it is on. Never its secrets.',
  server_tools: 'The tools a server offers, by their own names. A run calls one as `<server>__<tool>`.',
  try_server_tool:
    "Calls one of a server's tools, to see that it works: on its base instance, or with `workspaceId`, your own workspace's. Recorded in the activity.",
  restart_server:
    "Stops one of a server's instances, the base one or your own workspace's, so the next call starts it fresh.",
  install_server:
    'Installs a server from a registry, npm or PyPI, or adds one by its command or address. A person sets its secrets.',
  providers: 'Every model provider: its address and whether it is on. Never its key.',
  pools: 'Every pool: one model name served by several targets, and how it picks one.',
};

/** How a generated table's filter and order names end: `RunFilters`, `RunOrderBy`. */
const TABLE_INPUTS = ['Filters', 'OrderBy'];
/** How a generated column filter's name ends: `StringFilter`, and a to-many relation's `RunListRelationFilter`. */
const COLUMN_FILTER = 'Filter';
const LIST_RELATION_FILTER = 'ListRelationFilter';
/** The operators a column filter keeps. The pattern and negated forms, and its own `AND`, `OR` and `NOT`, go. */
const COLUMN_OPERATORS: ReadonlySet<string> = new Set([
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'inArray',
  'isNull',
  'contains',
  'iContains',
  'has',
]);

/**
 * Says whether an input field stays in a tool's schema, which the full filters would put far past the size budgets.
 *
 * @param field - A field of a generated input type.
 * @param parent - The input type it is a field of.
 * @returns false for relation filters and orders, to-one and to-many, which pull every related table's types in
 * recursively, and for a column filter's rarer operators. A table filter's own `AND`, `OR` and `NOT` stay.
 */
function isOwnColumnFilter(field: GraphQLInputField, parent: GraphQLInputObjectType): boolean {
  if (parent.name.endsWith(COLUMN_FILTER)) {
    return COLUMN_OPERATORS.has(field.name);
  }
  const { name } = getNamedType(field.type);
  const isOtherTable = TABLE_INPUTS.some((suffix) => name.endsWith(suffix)) && name !== parent.name;
  const isRelation = isOtherTable || name.endsWith(LIST_RELATION_FILTER);
  return isRelation === false;
}

/**
 * Puts the hand-written hint, when a tool has one, above its generated description.
 *
 * @param name - The tool's name.
 * @param description - The generated description.
 * @returns The description an agent reads.
 */
function describeTool(name: string, description: string): string {
  const hint = HINTS[name] ?? '';
  return hint === '' ? description : `${hint}\n\n${description}`;
}

/**
 * Builds the server factory for one set of roles: one tool for each root field the roles reach, and no other.
 *
 * @param schema - The permissioned schema /graphql serves.
 * @param roles - What the listing is for.
 * @returns The factory, which mints a server per instance with that instance's context.
 */
function factoryForRoles(schema: GraphQLSchema, roles: readonly AdminRole[]): ServerFactory {
  const ability = abilityForRoles(roles);
  return createServerFactory({
    schema,
    name: RESERVED_SERVER_NAME,
    version: version(),
    // A listing, not a lock: the permissions on the schema refuse whatever the roles don't reach.
    filter: (field, kind) => canReachField(ability, kind === OperationKind.query ? 'Query' : 'Mutation', field.name),
    exclude: [...UNLISTED_FIELDS],
    selectionDepth: MCP_DEFAULTS.selectionDepth,
    maxChars: MCP_DEFAULTS.maxResultChars,
    mutationHints: MutationHints.byName,
    // An explicit null on a write is how a model says "clear". On a filter it means nothing and costs bytes.
    nullBranches: (_field, kind) => (kind === OperationKind.query ? NullBranches.never : NullBranches.always),
    inputField: isOwnColumnFilter,
    decorate: (tool) => ({ description: describeTool(tool.name, tool.description) }),
  });
}

/**
 * Reads the caller one call to an admin server instance executes as.
 *
 * @param workspaceId - The instance's workspace. null for the listing a person sees, which no run calls.
 * @param roles - What the instance grants.
 * @param extra - The MCP request's `extra`, whose `_meta` the router's own dispatch filled in.
 * @returns The run's caller.
 * @throws FORBIDDEN for a call that names no run.
 */
function callerOf(workspaceId: string | null, roles: readonly AdminRole[], extra: unknown): RunCaller {
  const run = readRunMeta(isRecord(extra) ? extra._meta : undefined);
  if (run === null || workspaceId === null) {
    throw forbidden(RUNS_ONLY);
  }
  return { kind: CALLER_RUN, runId: run.runId, agentId: run.agentId, workspaceId, roles };
}

/**
 * Builds the admin server `ai-router`: the router's own management, as tools generated from the permissioned schema
 * /graphql serves, executed as the agent run that calls them.
 *
 * @param schema - The schema /graphql serves, permissions applied.
 * @param contextFor - Builds the context a run's call executes with.
 * @returns How the tools area connects an instance of it, in process: there is no endpoint.
 */
export function createAdminServer(schema: GraphQLSchema, contextFor: RunContextFactory): BuiltinConnector {
  /** Server factories by roles, since building one is most of what an instance costs. */
  const factories = new Map<string, ServerFactory>();
  const factoryFor = (roles: readonly AdminRole[]): ServerFactory => {
    const key = [...roles].sort().join(' ');
    const known = factories.get(key);
    if (known !== undefined) {
      return known;
    }
    const built = factoryForRoles(schema, roles);
    factories.set(key, built);
    return built;
  };

  return async (server: ResolvedServer) => {
    const { transport, workspaceId } = server;
    if (transport.type !== TRANSPORT_BUILTIN) {
      throw new Error(`Server "${server.name}" is not the built-in admin server.`);
    }
    const { roles } = transport;
    const mcp = factoryFor(roles)((extra: unknown) => contextFor(callerOf(workspaceId, roles, extra)));
    const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
    await connectServer(mcp, serverEnd);
    console.log(
      `[mcp] admin server connected for ${workspaceId === null ? 'a listing' : `workspace ${workspaceId}`}, roles: ${roles.join(', ') || 'none'}`,
    );
    return clientEnd;
  };
}
