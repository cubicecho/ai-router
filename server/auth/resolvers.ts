import { eq } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import { z } from 'zod';
import { secureLocalNet, serverUrl } from '../core/config.ts';
import type { Context } from '../core/context.ts';
import { forbidden } from '../core/errors.ts';
import { parseOrThrow } from '../core/validation.ts';
import { Role, users } from '../db/tables/users.ts';
import { objectType } from '../graphql/object-type.ts';
import { SSO_START_PATH } from '../http/sso.ts';
import { effectiveOidc } from '../sso/settings.ts';
import { deleteUser, setRole } from './admin.ts';
import { requireUser } from './caller.ts';
import { AuthFlow, throttle } from './throttle.ts';
import { signInLocalAdmin } from './trusted-network.ts';

const AUTH_SDL = parse(`
  "How people sign in to this router, so the sign-in page offers only that."
  type AuthConfig {
    "Whoever opens the UI is signed in as the admin, with no provider. Private networks only."
    trustedNetwork: Boolean!
    "The OIDC provider to sign in with (OIDC_ISSUER, or the paired one), or null when there is none."
    sso: SsoProvider
  }

  "An OpenID Connect provider the sign-in page offers."
  type SsoProvider {
    "What the button calls it (OIDC_NAME, or the name in the setup URL)."
    name: String!
    "Where the button sends the browser. Absolute: in development the server is not the UI's origin."
    signInUrl: String!
  }

  "A session, as the UI keeps it."
  type IssuedSession {
    "Sent back as \`Authorization: Bearer\`."
    token: String!
    userId: UUID!
  }

  extend type Query {
    authConfig: AuthConfig!
    "The signed-in user, with their role."
    me: User!
  }

  extend type Mutation {
    "On a trusted network (SECURE_LOCAL_NET), signs whoever opened the UI in as the local admin. Refused anywhere else."
    signInOnTrustedNetwork: IssuedSession!
    "Gives a user a role: admin or user. Admin only. Demoting the last admin is refused with CONFLICT."
    setUserRole(id: UUID!, role: UsersRoleEnum!): User!
    "Deletes a user and signs them out everywhere. Admin only. Deleting the last admin is refused with CONFLICT."
    deleteUser(id: UUID!): Boolean!
  }
`);

/** The roles a person may be given. */
const roleInput = z.enum([Role.Admin, Role.User], { error: 'A role is admin or user.' });

/** What a sign-in on an untrusted network is told. */
const NOT_TRUSTED = 'This router is not on a trusted network. Sign in with its OIDC provider.';

/**
 * Loads a user row.
 *
 * @param ctx - The request.
 * @param id - The user.
 * @returns The row, or undefined when there is none.
 */
async function loadUser(ctx: Context, id: string) {
  const [user] = await ctx.db.select().from(users).where(eq(users.id, id));
  return user;
}

/**
 * Adds sign-in, `me` and the role mutations to the schema. Sessions are better-auth's own endpoints (endpoints.ts).
 *
 * @param schema - The schema so far.
 * @returns The schema with them.
 */
export function applyAuthExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, AUTH_SDL);
  const queries = objectType(extended, 'Query').getFields();
  const mutations = objectType(extended, 'Mutation').getFields();

  queries.authConfig.resolve = async (_parent: unknown, _args: unknown, ctx: Context) => {
    const { config: oidc } = await effectiveOidc(ctx.db);
    return {
      trustedNetwork: secureLocalNet(),
      sso: oidc === null ? null : { name: oidc.name, signInUrl: `${serverUrl()}${SSO_START_PATH}` },
    };
  };

  queries.me.resolve = async (_parent: unknown, _args: unknown, ctx: Context) => {
    const { userId } = requireUser(ctx.caller);
    return loadUser(ctx, userId);
  };

  mutations.signInOnTrustedNetwork.resolve = (_parent: unknown, _args: unknown, ctx: Context) =>
    throttle(ctx, AuthFlow.TrustedNetwork, async () => {
      if (secureLocalNet() === false) {
        throw forbidden(NOT_TRUSTED);
      }
      return signInLocalAdmin(ctx.db, ctx.auth);
    });

  mutations.setUserRole.resolve = async (_parent: unknown, args: { id: string; role: string }, ctx: Context) => {
    const role = parseOrThrow(roleInput, args.role);
    await setRole(ctx.db, args.id, role);
    return loadUser(ctx, args.id);
  };

  mutations.deleteUser.resolve = async (_parent: unknown, args: { id: string }, ctx: Context) => {
    await deleteUser(ctx.db, args.id);
    return true;
  };

  return extended;
}
