import { asc, eq } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { Context } from '../core/context.ts';
import { badInput, conflict, notFound } from '../core/errors.ts';
import { parseOrThrow } from '../core/validation.ts';
import { violatedUniqueIndex } from '../db/errors.ts';
import { agents } from '../db/tables/agents.ts';
import { DEFAULT_POLICY_ID, type OverridePolicy, overridePolicies } from '../db/tables/override-policies.ts';
import { objectType } from '../graphql/object-type.ts';
import { selectedId } from '../graphql/selected-id.ts';
import { overridePolicyInputSchema } from './policy.ts';
import { READ_FIELDS } from './request.ts';

/** The unique index that keeps policy names apart. */
const UNIQUE_NAME = 'uq_override_policies_name';
/** How many of the agents using a policy a refused delete names. */
const NAMED_AGENTS = 5;

const POLICIES_SDL = parse(`
  "What a policy lets the layers above an agent do. Nothing it leaves out is quietly trimmed: a request that needs it is refused."
  input OverridePolicyRulesInput {
    "The app's leading system or developer messages become the agent's host prompt part."
    hostPrompt: Boolean!
    "ai_router.task becomes the agent's task prompt part."
    taskPrompt: Boolean!
    "A request may narrow the agent's servers. It never widens them."
    narrowServers: Boolean!
    "The request fields an app may set, by their OpenAI wire names: temperature, max_tokens, top_p and the like."
    sampling: [String!]!
    "A request may send response_format."
    responseFormat: Boolean!
  }

  "An override policy as an admin writes it."
  input OverridePolicyInput {
    "Its name: lowercase letters, digits, dots, dashes and underscores."
    name: String!
    "What it is for, for the people choosing it."
    description: String
    rules: OverridePolicyRulesInput!
  }

  extend type OverridePolicy {
    "Whether it is the seeded default: what a new agent starts with, never deleted. Select id with it."
    isDefault: Boolean!
  }

  extend type Mutation {
    "Adds an override policy, which any user may then choose for an agent. Admin only."
    createOverridePolicy(values: OverridePolicyInput!): OverridePolicy!
    "Rewrites an override policy. Every agent using it follows the new rules from its next request. Admin only."
    updateOverridePolicy(id: UUID!, values: OverridePolicyInput!): OverridePolicy!
    "Deletes an override policy that no agent uses. The default is never deleted. Admin only."
    deleteOverridePolicy(id: UUID!): OverridePolicy!
    "Chooses the override policy an agent's runs are checked against, from its next request."
    setAgentOverridePolicy(id: UUID!, policyId: UUID!): Agent!
  }
`);

/** What a policy write takes. */
interface PolicyArgs {
  values: unknown;
}

/**
 * Writes a policy, turning a name another policy has into BAD_USER_INPUT.
 *
 * @param write - The insert or update.
 * @returns The policy it wrote, or undefined when an update found none.
 */
async function writePolicy(write: () => Promise<OverridePolicy[]>): Promise<OverridePolicy | undefined> {
  try {
    const [row] = await write();
    return row;
  } catch (error) {
    if (violatedUniqueIndex(error) === UNIQUE_NAME) {
      throw badInput('An override policy with that name already exists.');
    }
    throw error;
  }
}

/**
 * Adds the override policy writes: an admin's policies, and a user's choice of one per agent. Reading them is the
 * generated `overridePolicies`.
 *
 * @param schema - Schema to extend.
 * @returns The extended schema.
 */
export function applyPoliciesExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, POLICIES_SDL);
  const mutations = objectType(extended, 'Mutation').getFields();
  const policyFields = objectType(extended, 'OverridePolicy').getFields();
  policyFields.isDefault.resolve = (parent: { id?: string }) =>
    selectedId(parent, 'override policy', 'isDefault') === DEFAULT_POLICY_ID;
  const inputSchema = overridePolicyInputSchema(READ_FIELDS);

  mutations.createOverridePolicy.resolve = async (_parent: unknown, args: PolicyArgs, ctx: Context) => {
    const values = parseOrThrow(inputSchema, args.values);
    const policy = await writePolicy(() => ctx.db.insert(overridePolicies).values(values).returning());
    if (policy === undefined) {
      throw new Error('The policy was not recorded.');
    }
    return policy;
  };

  mutations.updateOverridePolicy.resolve = async (
    _parent: unknown,
    args: PolicyArgs & { id: string },
    ctx: Context,
  ) => {
    const values = parseOrThrow(inputSchema, args.values);
    const policy = await writePolicy(() =>
      ctx.db.update(overridePolicies).set(values).where(eq(overridePolicies.id, args.id)).returning(),
    );
    if (policy === undefined) {
      throw notFound('Override policy not found.');
    }
    await ctx.snapshot.rebuild();
    return policy;
  };

  mutations.deleteOverridePolicy.resolve = async (_parent: unknown, args: { id: string }, ctx: Context) => {
    if (args.id === DEFAULT_POLICY_ID) {
      throw badInput('The default policy stays: a new agent starts with it.');
    }
    return ctx.db.transaction(async (tx) => {
      const [policy] = await tx.select().from(overridePolicies).where(eq(overridePolicies.id, args.id)).for('update');
      if (policy === undefined) {
        throw notFound('Override policy not found.');
      }
      const users = await tx
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.overridePolicyId, policy.id))
        .orderBy(asc(agents.name));
      if (users.length > 0) {
        const named = users.slice(0, NAMED_AGENTS).map((agent) => agent.name);
        const more = users.length > named.length ? `, and ${users.length - named.length} more` : '';
        throw conflict(
          `"${policy.name}" is in use by ${named.join(', ')}${more}. Choose another policy for them first.`,
        );
      }
      await tx.delete(overridePolicies).where(eq(overridePolicies.id, policy.id));
      return policy;
    });
  };

  mutations.setAgentOverridePolicy.resolve = async (
    _parent: unknown,
    args: { id: string; policyId: string },
    ctx: Context,
  ) => {
    const [policy] = await ctx.db
      .select({ id: overridePolicies.id })
      .from(overridePolicies)
      .where(eq(overridePolicies.id, args.policyId));
    if (policy === undefined) {
      throw notFound('Override policy not found.');
    }
    const [agent] = await ctx.db
      .update(agents)
      .set({ overridePolicyId: policy.id })
      .where(eq(agents.id, args.id))
      .returning();
    if (agent === undefined) {
      throw notFound('Agent not found.');
    }
    await ctx.snapshot.rebuild();
    return agent;
  };

  return extended;
}
