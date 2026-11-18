import type { Request } from 'express';
import { type GraphQLSchema, NoSchemaIntrospectionCustomRule } from 'graphql';
import { createYoga, type Plugin } from 'graphql-yoga';
import { ConflictingKeysError, readCaller } from '../auth/caller.ts';
import { isProduction } from '../core/config.ts';
import { type Context, type ContextDeps, UNKNOWN_IP } from '../core/context.ts';
import { badInput } from '../core/errors.ts';
import { graphqlLogger } from './logger.ts';
import { useOperationLimits } from './operation-limits.ts';

/** Builds one request's context from its headers and the caller's address. */
export type ContextFactory = (headers: Headers, ip?: string) => Promise<Context>;

/**
 * Builds the context factory every door shares, so each reads the caller the same way.
 *
 * @param deps - The database, auth host, snapshot and sign-in limiter every resolver is given.
 * @param [now] - The clock keys' expiry is judged by.
 * @returns The factory. It throws {@link ConflictingKeysError} for a request sending two different keys.
 */
export function createContextFactory(deps: ContextDeps, now: () => Date = () => new Date()): ContextFactory {
  return async (headers, ip = UNKNOWN_IP) => {
    // Asked per request: pairing a provider swaps the instance.
    const auth = deps.authHost.current();
    const caller = await readCaller({ auth, snapshot: deps.snapshot.current(), now: now() }, headers);
    return { ...deps, auth, caller, headers, ip };
  };
}

/** What Express hands Yoga alongside the fetch request. */
interface ServerContext {
  /** Absent when a test calls `yoga.fetch`. */
  req?: Request;
}

/**
 * Refuses introspection, so a production router does not hand out its schema.
 *
 * @returns The plugin, for `createYoga({ plugins })`.
 */
function useNoIntrospection(): Plugin {
  return {
    onValidate: ({ addValidationRule }) => {
      addValidationRule(NoSchemaIntrospectionCustomRule);
    },
  };
}

/**
 * Builds the Yoga handler for /graphql.
 *
 * @param schema - The permission-wrapped schema.
 * @param contextFor - Builds a request's context.
 * @returns The Yoga instance, callable as Express middleware.
 */
export function createGraphQLHandler(schema: GraphQLSchema, contextFor: ContextFactory) {
  return createYoga<ServerContext, Context>({
    schema,
    graphqlEndpoint: '/graphql',
    graphiql: isProduction() === false,
    // Masked errors are logged here with their real cause.
    logging: graphqlLogger,
    plugins: [useOperationLimits(), ...(isProduction() ? [useNoIntrospection()] : [])],
    context: async ({ request, req }) => {
      try {
        // Express's view of the client, which honours TRUST_PROXY.
        return await contextFor(request.headers, req?.ip);
      } catch (error) {
        throw error instanceof ConflictingKeysError ? badInput(error.message) : error;
      }
    },
  });
}
