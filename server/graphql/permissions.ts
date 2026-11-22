import { type Action, Actions, accept, deny, type PermissionsMap, type Rule, rule } from '@vantreeseba/graphql-casl';
import { CALLER_RUN, CALLER_USER, type Context } from '../core/context.ts';
import { forbidden, unauthenticated } from '../core/errors.ts';
import { Role } from '../db/tables/users.ts';
import { abilityFor, FIELD_GRANTS, type FieldGrant, type RouterAbility, Subject } from './abilities.ts';

// Who may call what on /graphql and through the admin server. A person may call anything people may, an admin
// more. An agent run reaches only the fields in FIELD_GRANTS that its workspace's roles allow (abilities.ts).
// A workspace key is refused everywhere. Mutations are a whitelist, so a generated write a new table adds arrives
// shut, and a root field missing from FIELD_GRANTS is for people only.

/** What a workspace key on /graphql is told. */
const PEOPLE_ONLY = 'The admin API is for people signed in to the router. A workspace key cannot use it.';
/** What an agent run reaching past its roles is told. */
const PAST_ROLES = "Its workspace's roles for the ai-router server don't allow this.";
/** What an agent run reaching for something only people do is told. */
const RUNS_NEVER = 'Only a person can do this. An agent run cannot, whatever its roles.';
/** What a user reaching for an admin's field is told. */
const ADMIN_ONLY = 'Only an admin can do this.';

/** Each request's ability, built once. */
const abilities = new WeakMap<Context, RouterAbility>();

/**
 * Reads the ability of a request's caller, building it on first use.
 *
 * @param ctx - The request.
 * @returns What its caller may do.
 */
function abilityOf(ctx: Context): RouterAbility {
  const known = abilities.get(ctx);
  if (known !== undefined) {
    return known;
  }
  const built = abilityFor(ctx.caller);
  abilities.set(ctx, built);
  return built;
}

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
  if (ctx.caller.kind === CALLER_RUN) {
    return forbidden(RUNS_NEVER);
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

/**
 * Builds the rule for something a person may do, and an agent run only when its roles allow.
 *
 * @param action - What is done.
 * @param subject - To what.
 * @returns The rule.
 */
function canDo(action: Action, subject: Subject): Rule {
  return rule(
    (_parent, _args, ctx: Context) => {
      const { caller } = ctx;
      if (caller === null) {
        return unauthenticated('Sign in first.');
      }
      if (caller.kind !== CALLER_USER && caller.kind !== CALLER_RUN) {
        return forbidden(PEOPLE_ONLY);
      }
      return abilityOf(ctx).can(action, subject) ? true : forbidden(PAST_ROLES);
    },
    { name: `can ${action} ${subject}`, cache: 'contextual' },
  );
}

/**
 * Builds the rules for the root fields a role can reach.
 *
 * @param grants - The fields, with what each needs.
 * @returns A rule for each.
 */
function grantedFields(grants: Readonly<Record<string, FieldGrant>>): Record<string, Rule> {
  return Object.fromEntries(
    Object.entries(grants).map(([field, { action, subject }]) => [field, canDo(action, subject)]),
  );
}

/** Any signed-in person. */
const isUser = rule(checkUser, { name: 'isUser', cache: 'contextual' });
/** An admin. */
const isAdmin = rule(checkAdmin, { name: 'isAdmin', cache: 'contextual' });
/**
 * Anyone but a workspace key or a run: signing in, and pairing a provider on a router with no accounts yet.
 * The resolvers decide the rest.
 */
const notAKey = rule((_parent, _args, ctx: Context) => (ctx.caller === null ? true : checkUser(_parent, _args, ctx)), {
  name: 'notAKey',
});

const { read } = Actions;

/** The schema's permission map. Applied once, in createSchema. */
export const permissions: PermissionsMap = {
  '*': accept,
  Query: {
    '*': isUser,
    ...grantedFields(FIELD_GRANTS.Query),
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
    ...grantedFields(FIELD_GRANTS.Mutation),
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
    updateRouterSettings: isAdmin,
    createWorkspace: isUser,
    updateWorkspace: isUser,
    deleteWorkspace: isUser,
    createWorkspaceKey: isUser,
    revokeWorkspaceKey: isUser,
    setProviderApiKey: isAdmin,
    setModelPrice: isUser,
    setServerSecret: isAdmin,
    setServerLoginClient: isAdmin,
    promoteRevision: isUser,
    setAgentAutoPromote: isUser,
    deleteAgent: isUser,
    createWorkspaceAgent: isUser,
    deleteWorkspaceAgent: isUser,
    // People only: no admin-server role reaches it, so a run never turns a server on for itself.
    setWorkspaceAgentServerEnabled: isUser,
    createWorkspaceServer: isUser,
    updateWorkspaceServer: isUser,
    deleteWorkspaceServer: isUser,
    // People only, never a run on the admin server: no role grants stopping another run.
    cancelRun: isUser,
  },
  // A rule on a type guards it wherever it is reached, a relation included, so a run's read of an agent can't walk
  // into the workspaces that run it.
  Agent: canDo(read, Subject.Agent),
  AgentRevision: canDo(read, Subject.AgentRevision),
  Provider: canDo(read, Subject.Provider),
  ModelPrice: canDo(read, Subject.Provider),
  Pool: canDo(read, Subject.Pool),
  PoolTarget: canDo(read, Subject.Pool),
  Server: canDo(read, Subject.Server),
  ServerInstance: canDo(read, Subject.Server),
  Registry: canDo(read, Subject.Registry),
  Run: canDo(read, Subject.Run),
  // Read across every workspace, so people only: a run on the admin server reaches its own workspace's runs.
  RunSession: isUser,
  RunSessionPage: isUser,
  Activity: isUser,
  Conversation: isUser,
  ServerSecret: isUser,
  UsageCount: isUser,
  User: isUser,
  Workspace: isUser,
  WorkspaceAgent: isUser,
  WorkspaceAgentDisabledServer: isUser,
  WorkspaceAgentDisabledTool: isUser,
  WorkspaceKey: isUser,
  WorkspaceServer: isUser,
};
