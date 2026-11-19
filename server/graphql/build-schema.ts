import { buildSchema } from '@vantreeseba/drizzle-graphql';
import { applyPermissions } from '@vantreeseba/graphql-casl';
import { type AnyColumn, eq } from 'drizzle-orm';
import { GraphQLObjectType, GraphQLSchema } from 'graphql';
import { agentWriteHooks } from '../agents/hooks.ts';
import { applyAgentsExtension } from '../agents/resolvers.ts';
import { applyRunsExtension } from '../agents/run-resolvers.ts';
import { applyBetterAuthExtension } from '../auth/endpoints.ts';
import { applyAuthExtension } from '../auth/resolvers.ts';
import { CALLER_RUN, type Context } from '../core/context.ts';
import { OPERATION_LIMIT_DEFAULTS } from '../core/defaults.ts';
import { forbidden } from '../core/errors.ts';
import type { DB } from '../db/client.ts';
import { modelWriteHooks } from '../models/hooks.ts';
import { applyModelsExtension } from '../models/resolvers.ts';
import { applySettingsExtension } from '../settings/resolvers.ts';
import { applySsoExtension } from '../sso/resolvers.ts';
import { toolWriteHooks } from '../tools/hooks.ts';
import { applyToolsExtension } from '../tools/resolvers.ts';
import { workspaceWriteHooks } from '../workspaces/hooks.ts';
import { applyWorkspacesExtension } from '../workspaces/resolvers.ts';
import { mapDatabaseError } from './database-errors.ts';
import { permissions } from './permissions.ts';

/** better-auth's tables, and the pairing's secrets. Never served: every read of them goes through the server. */
const SERVER_TABLES = ['sessions', 'accounts', 'verifications', 'oidcSettings'];

/**
 * Tables served only through hand-written fields: a run's events are `Run.events`, in the subscription's shape, and
 * the router's settings are `routerSettings`, with their defaults filled in.
 */
const HAND_SERVED_TABLES = ['runEvents', 'settings'];

/**
 * Tables whose writes belong to hand-written mutations or to the server: sign-in, roles, keys, targets,
 * usage, model prices, secrets, activity, runs and conversations.
 */
const WRITES_RESERVED = new Set<string>([
  'users',
  'workspaceKeys',
  'poolTargets',
  'usageCounts',
  'modelPrices',
  'serverSecrets',
  'activity',
  'agentRevisions',
  'overridePolicies',
  'runs',
  'conversations',
]);

/** Tables whose rows are created by hand-written mutations: `installServer`, `createAgent`. */
const CREATE_RESERVED = new Set<string>(['servers', 'agents']);

/** Tables whose rows change only through hand-written mutations: an agent changes by its revisions. */
const UPDATE_RESERVED = new Set<string>(['agents']);

/** Tables whose rows are removed by hand-written mutations: `deleteServer` also stops it and removes its folder. */
const DELETE_RESERVED = new Set<string>(['servers']);

/**
 * Whether a table keeps its generated writes.
 *
 * @param table - Table key.
 * @returns false for reserved tables.
 */
const generatedWritesAllowed = (table: string): boolean => WRITES_RESERVED.has(table) === false;

/**
 * Makes the check for one kind of generated write.
 *
 * @param reserved - The tables whose writes of that kind are hand-written.
 * @returns Whether a table keeps that generated write.
 */
const allowedUnless =
  (reserved: ReadonlySet<string>) =>
  (table: string): boolean =>
    generatedWritesAllowed(table) && reserved.has(table) === false;

/**
 * Adds an empty Mutation root when every generated write is off, so `extend type Mutation` has a target.
 *
 * @param schema - Generated schema.
 * @returns The schema, with a Mutation root.
 */
function withMutationRoot(schema: GraphQLSchema): GraphQLSchema {
  if (schema.getMutationType() !== undefined && schema.getMutationType() !== null) {
    return schema;
  }
  return new GraphQLSchema({ ...schema.toConfig(), mutation: new GraphQLObjectType({ name: 'Mutation', fields: {} }) });
}

/**
 * Builds the served schema over a database: the generated CRUD, the hand-written fields, then permissions.
 *
 * @param db - The database the resolvers query. Tests pass PGlite.
 * @returns The permission-wrapped schema.
 */
export function createSchema(db: DB): GraphQLSchema {
  const { schema: generated } = buildSchema(db, {
    prefixes: { insert: 'create', update: 'update', delete: 'delete' },
    // Table keys are plural (`workspaces`). Types and single-row fields are singular (Workspace, workspace).
    typeNameMapper: 'singularize',
    exclude: {
      tables: [...SERVER_TABLES, ...HAND_SERVED_TABLES],
      columns: {
        workspaceKeys: ['hash'],
        providers: ['apiKey'],
        servers: ['oauth'],
        serverSecrets: ['value'],
        // A fingerprint of an app's request: of no use to a person, and a way to test a guess at what it said.
        // A waiting run's transcript and the app's tools: what it carries on with, not what it is.
        runs: ['requestHash', 'resume'],
      },
    },
    features: {
      insert: allowedUnless(CREATE_RESERVED),
      update: allowedUnless(UPDATE_RESERVED),
      updateMany: allowedUnless(UPDATE_RESERVED),
      delete: allowedUnless(DELETE_RESERVED),
      // The hooks read the root field's args, not a nested child's. Stated so nobody turns it on.
      nestedWrites: false,
    },
    limits: {
      defaultLimit: OPERATION_LIMIT_DEFAULTS.defaultPageSize,
      maxLimit: OPERATION_LIMIT_DEFAULTS.maxPageSize,
    },
    complexity: true,
    // A stored value such as `least-busy` is no GraphQL name: it is served as `least_busy`, and stored as it was.
    enumValueNameMapper: ({ value }) => value.replaceAll('-', '_'),
    // An agent run reads only the runs its own workspace started, a relation's included. People read every run.
    scope: {
      runs: (ctx: Context, table: { workspaceId: AnyColumn }) =>
        ctx.caller?.kind === CALLER_RUN ? eq(table.workspaceId, ctx.caller.workspaceId) : undefined,
    },
    onWrite: { ...workspaceWriteHooks, ...modelWriteHooks, ...toolWriteHooks, ...agentWriteHooks },
    onError: mapDatabaseError,
  });

  const withAuth = applySsoExtension(applyBetterAuthExtension(applyAuthExtension(withMutationRoot(generated)), db));
  const extended = applySettingsExtension(
    applyRunsExtension(
      applyAgentsExtension(applyToolsExtension(applyModelsExtension(applyWorkspacesExtension(withAuth)))),
    ),
  );
  return applyPermissions(extended, permissions, {
    // A refusal names the field, so a client can tell which call to stop making.
    fallbackError: (_original, _parent, _args, _context, info) =>
      forbidden(`Not allowed to call ${info.parentType.name}.${info.fieldName}.`),
  });
}
