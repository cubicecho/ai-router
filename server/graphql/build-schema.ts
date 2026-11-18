import { buildSchema } from '@vantreeseba/drizzle-graphql';
import { applyPermissions } from '@vantreeseba/graphql-casl';
import { GraphQLObjectType, GraphQLSchema } from 'graphql';
import { applyBetterAuthExtension } from '../auth/endpoints.ts';
import { applyAuthExtension } from '../auth/resolvers.ts';
import { OPERATION_LIMIT_DEFAULTS } from '../core/defaults.ts';
import { forbidden } from '../core/errors.ts';
import type { DB } from '../db/client.ts';
import { applySsoExtension } from '../sso/resolvers.ts';
import { workspaceWriteHooks } from '../workspaces/hooks.ts';
import { applyWorkspacesExtension } from '../workspaces/resolvers.ts';
import { mapDatabaseError } from './database-errors.ts';
import { permissions } from './permissions.ts';

/** better-auth's tables, and the pairing's secrets. Never served: every read of them goes through the server. */
const SERVER_TABLES = ['sessions', 'accounts', 'verifications', 'oidcSettings'];

/** Tables whose writes belong to hand-written mutations: the sign-in flow, roles and keys. */
const WRITES_RESERVED = new Set<string>(['users', 'workspaceKeys']);

/**
 * Whether a table keeps its generated writes.
 *
 * @param table - Table key.
 * @returns false for reserved tables.
 */
const generatedWritesAllowed = (table: string): boolean => WRITES_RESERVED.has(table) === false;

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
    exclude: { tables: SERVER_TABLES, columns: { workspaceKeys: ['hash'] } },
    features: {
      insert: generatedWritesAllowed,
      update: generatedWritesAllowed,
      updateMany: generatedWritesAllowed,
      delete: generatedWritesAllowed,
      // The hooks read the root field's args, not a nested child's. Stated so nobody turns it on.
      nestedWrites: false,
    },
    limits: {
      defaultLimit: OPERATION_LIMIT_DEFAULTS.defaultPageSize,
      maxLimit: OPERATION_LIMIT_DEFAULTS.maxPageSize,
    },
    complexity: true,
    onWrite: { ...workspaceWriteHooks },
    onError: mapDatabaseError,
  });

  const withAuth = applySsoExtension(applyBetterAuthExtension(applyAuthExtension(withMutationRoot(generated)), db));
  const extended = applyWorkspacesExtension(withAuth);
  return applyPermissions(extended, permissions, {
    // A refusal names the field, so a client can tell which call to stop making.
    fallbackError: (_original, _parent, _args, _context, info) =>
      forbidden(`Not allowed to call ${info.parentType.name}.${info.fieldName}.`),
  });
}
