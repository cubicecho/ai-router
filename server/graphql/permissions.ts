import { accept, deny, type PermissionsMap, rule } from '@vantreeseba/graphql-casl';
import { CALLER_USER, type Context } from '../core/context.ts';
import { forbidden, unauthenticated } from '../core/errors.ts';
import { Role } from '../db/tables/users.ts';

// Who may call what on /graphql. Only people use it: a workspace key is refused everywhere, signed in or not.
// Mutations are a whitelist, so a generated write a new table adds arrives shut.

/** What a workspace key on /graphql is told. */
const PEOPLE_ONLY = 'The admin API is for people signed in to the router. A workspace key cannot use it.';
/** What a user reaching for an admin's field is told. */
const ADMIN_ONLY = 'Only an admin can do this.';

/**
 * Refuses everyone but a signed-in person.
 *
 * @param _parent - Unused.
 * @param _args - Unused.
 * @param ctx - The request.
 * @returns true for a person, otherwise the error to refuse with.
 */
function checkUser(_parent: unknown, _args: unknown, ctx: Context): true | Error {
  if (ctx.caller === null) {
    return unauthenticated('Sign in first.');
  }
  return ctx.caller.kind === CALLER_USER ? true : forbidden(PEOPLE_ONLY);
}

/**
 * Refuses everyone but an admin.
 *
 * @param parent - Unused.
 * @param args - Unused.
 * @param ctx - The request.
 * @returns true for an admin, otherwise the error to refuse with.
 */
function checkAdmin(parent: unknown, args: unknown, ctx: Context): true | Error {
  const asUser = checkUser(parent, args, ctx);
  if (asUser !== true) {
    return asUser;
  }
  return ctx.caller?.kind === CALLER_USER && ctx.caller.role === Role.Admin ? true : forbidden(ADMIN_ONLY);
}

/** Any signed-in person. */
const isUser = rule(checkUser, { name: 'isUser' });
/** An admin. */
const isAdmin = rule(checkAdmin, { name: 'isAdmin' });
/**
 * Anyone but a workspace key: signing in, and pairing a provider on a router with no accounts yet.
 * The resolvers decide the rest.
 */
const notAKey = rule((_parent, _args, ctx: Context) => (ctx.caller === null ? true : checkUser(_parent, _args, ctx)), {
  name: 'notAKey',
});

/** The schema's permission map. Applied once, in createSchema. */
export const permissions: PermissionsMap = {
  '*': accept,
  Query: {
    '*': isUser,
    // The sign-in page reads these signed out.
    authConfig: notAKey,
    ssoSetup: notAKey,
  },
  // A run's live events are for people. An app reads its runs at /runs from phase 7.
  Subscription: {
    '*': isUser,
  },
  Mutation: {
    '*': deny,
    verifyOneTimeToken: notAKey,
    signInOnTrustedNetwork: notAKey,
    signOut: isUser,
    revokeSession: isUser,
    revokeSessions: isUser,
    revokeOtherSessions: isUser,
    // canPairSso decides who: the admin, or anyone while there are no accounts.
    pairSso: notAKey,
    unpairSso: notAKey,
    setUserRole: isAdmin,
    deleteUser: isAdmin,
    createWorkspace: isUser,
    updateWorkspace: isUser,
    deleteWorkspace: isUser,
    createWorkspaceKey: isUser,
    revokeWorkspaceKey: isUser,
    createProvider: isUser,
    updateProvider: isUser,
    deleteProvider: isUser,
    setProviderApiKey: isAdmin,
    createPool: isUser,
    updatePool: isUser,
    deletePool: isUser,
    setPoolTargets: isUser,
    createRegistry: isUser,
    updateRegistry: isUser,
    deleteRegistry: isUser,
    updateServer: isUser,
    setServerSecret: isAdmin,
    installServer: isUser,
    deleteServer: isUser,
    restartServer: isUser,
    tryServerTool: isUser,
    startServerLogin: isUser,
    signOutServer: isUser,
    setServerLoginClient: isAdmin,
    createAgent: isUser,
    saveAgent: isUser,
    promoteRevision: isUser,
    deleteAgent: isUser,
    createWorkspaceAgent: isUser,
    deleteWorkspaceAgent: isUser,
    createWorkspaceServer: isUser,
    updateWorkspaceServer: isUser,
    deleteWorkspaceServer: isUser,
  },
};
