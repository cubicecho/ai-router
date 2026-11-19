import { and, eq, inArray } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { Context } from '../core/context.ts';
import { MODEL_CONFIG_DEFAULTS } from '../core/defaults.ts';
import { badInput, notFound, upstreamFailed } from '../core/errors.ts';
import { parseOrThrow } from '../core/validation.ts';
import type { Snapshot, SnapshotProvider } from '../db/snapshot.ts';
import { modelPrices } from '../db/tables/model-prices.ts';
import { EQUAL_WEIGHT, poolTargets } from '../db/tables/pool-targets.ts';
import { pools } from '../db/tables/pools.ts';
import { providers } from '../db/tables/providers.ts';
import { objectType } from '../graphql/object-type.ts';
import { ModelListError } from './catalog.ts';
import { apiKeyInput, modelPriceInput, targetsInput } from './input.ts';

const MODELS_SDL = parse(`
  "One model as its provider lists it."
  type ProviderModel {
    "The model's id at the provider. An agent names it as <provider>/<id>."
    id: String!
    "Who the provider says made it, when it says."
    ownedBy: String
  }

  "How busy one of a pool's targets is right now."
  type TargetLoad {
    providerId: UUID!
    providerName: String!
    model: String!
    "Its share of the pool's calls, against a target of weight 1."
    weight: Int!
    "Calls sent to it that haven't finished."
    inFlight: Int!
    "False while it is passed over: a call could not reach it lately, or the last health check found it down. Every pool that has it passes it over."
    reachable: Boolean!
    "When a health check last looked at it. Null before the first check, or while its pool or provider is off."
    checkedAt: DateTime
    "Why it is passed over, while it is. Null while it is reachable."
    downReason: String
  }

  "What a model costs per million tokens, in whatever currency the prices are entered in."
  input ModelPriceInput {
    inputPerMillion: Float!
    outputPerMillion: Float!
  }

  "One of a pool's targets, as setPoolTargets takes them."
  input PoolTargetInput {
    providerId: UUID!
    "The model's id at the provider."
    model: String!
    "Its share of the pool's calls, from ${EQUAL_WEIGHT} to ${MODEL_CONFIG_DEFAULTS.maxTargetWeight}: a target of weight 2 takes twice the calls of one of weight 1."
    weight: Int! = ${EQUAL_WEIGHT}
  }

  extend type Query {
    "What a provider serves now, from its own model list. Cached for a minute unless refresh is true."
    providerModels(id: UUID!, refresh: Boolean): [ProviderModel!]!
    "How many calls each of a pool's targets has in flight, and whether it is being passed over and why."
    poolLoad(id: UUID!): [TargetLoad!]!
  }

  extend type Mutation {
    "Sets a provider's key, sent as Authorization: Bearer. Null or empty clears it. Admin only."
    setProviderApiKey(id: UUID!, apiKey: String): Provider!
    "Sets what a provider's model costs, for usage to show; null clears it. Answers the price, or null once cleared. A call through a pool with its own price costs the pool's."
    setModelPrice(providerId: UUID!, model: String!, price: ModelPriceInput): ModelPrice
    "Replaces a pool's targets with these, in this order."
    setPoolTargets(poolId: UUID!, targets: [PoolTargetInput!]!): Pool!
  }
`);

/**
 * Finds a provider in the snapshot by its id.
 *
 * @param snapshot - What the router routes by.
 * @param id - The provider.
 * @returns The provider.
 * @throws NOT_FOUND when there is none.
 */
function providerById(snapshot: Snapshot, id: string): SnapshotProvider {
  const found = [...snapshot.providers.values()].find((provider) => provider.id === id);
  if (found === undefined) {
    throw notFound('Provider not found.');
  }
  return found;
}

/**
 * Adds the models fields CRUD can't express: the write-only key, a pool's targets, model prices, model lists and load.
 *
 * @param schema - Schema to extend.
 * @returns The extended schema.
 */
export function applyModelsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, MODELS_SDL);
  const queries = objectType(extended, 'Query').getFields();
  const mutations = objectType(extended, 'Mutation').getFields();

  queries.providerModels.resolve = async (
    _parent: unknown,
    args: { id: string; refresh?: boolean | null },
    ctx: Context,
  ) => {
    const provider = providerById(ctx.snapshot.current(), args.id);
    const { catalog } = ctx.models;
    try {
      const models = await (args.refresh === true ? catalog.refresh(provider) : catalog.list(provider));
      return models.map((model) => ({
        id: model.id,
        ownedBy: typeof model.owned_by === 'string' ? model.owned_by : null,
      }));
    } catch (error) {
      throw error instanceof ModelListError ? upstreamFailed(error.message) : error;
    }
  };

  queries.poolLoad.resolve = (_parent: unknown, args: { id: string }, ctx: Context) => {
    const pool = [...ctx.snapshot.current().pools.values()].find((candidate) => candidate.id === args.id);
    if (pool === undefined) {
      throw notFound('Pool not found.');
    }
    const { balancer } = ctx.models;
    return pool.targets.map((target) => ({
      ...target,
      ...balancer.healthOf(target),
      inFlight: balancer.inFlightTo(target),
    }));
  };

  mutations.setProviderApiKey.resolve = async (
    _parent: unknown,
    args: { id: string; apiKey?: string | null },
    ctx: Context,
  ) => {
    const typed = parseOrThrow(apiKeyInput, args.apiKey ?? null);
    const apiKey = typed === null || typed === '' ? null : typed;
    const [updated] = await ctx.db.update(providers).set({ apiKey }).where(eq(providers.id, args.id)).returning();
    if (updated === undefined) {
      throw notFound('Provider not found.');
    }
    await ctx.snapshot.rebuild();
    const { apiKey: _secret, ...served } = updated;
    return served;
  };

  mutations.setModelPrice.resolve = async (
    _parent: unknown,
    args: { providerId: string; model: string; price?: { inputPerMillion: number; outputPerMillion: number } | null },
    ctx: Context,
  ) => {
    const { price } = args;
    const { model, ...perMillion } = parseOrThrow(modelPriceInput, {
      model: args.model,
      inputPerMillion: price?.inputPerMillion ?? 0,
      outputPerMillion: price?.outputPerMillion ?? 0,
    });
    const [provider] = await ctx.db
      .select({ id: providers.id })
      .from(providers)
      .where(eq(providers.id, args.providerId));
    if (provider === undefined) {
      throw notFound('Provider not found.');
    }
    const isClearing = price === null || price === undefined;
    if (isClearing) {
      await ctx.db
        .delete(modelPrices)
        .where(and(eq(modelPrices.providerId, provider.id), eq(modelPrices.model, model)));
      return null;
    }
    const [saved] = await ctx.db
      .insert(modelPrices)
      .values({ providerId: provider.id, model, ...perMillion })
      .onConflictDoUpdate({
        target: [modelPrices.providerId, modelPrices.model],
        set: { ...perMillion, updatedAt: new Date() },
      })
      .returning();
    return saved;
  };

  mutations.setPoolTargets.resolve = async (
    _parent: unknown,
    args: { poolId: string; targets: { providerId: string; model: string; weight: number }[] },
    ctx: Context,
  ) => {
    const targets = parseOrThrow(targetsInput, args.targets);
    const pool = await ctx.db.transaction(async (tx) => {
      const [found] = await tx.select().from(pools).where(eq(pools.id, args.poolId)).for('update');
      if (found === undefined) {
        throw notFound('Pool not found.');
      }
      const providerIds = [...new Set(targets.map((target) => target.providerId))];
      const known =
        providerIds.length === 0
          ? []
          : await tx.select({ id: providers.id }).from(providers).where(inArray(providers.id, providerIds));
      if (known.length !== providerIds.length) {
        throw badInput('A target names a provider that does not exist.');
      }
      await tx.delete(poolTargets).where(eq(poolTargets.poolId, found.id));
      if (targets.length > 0) {
        await tx
          .insert(poolTargets)
          .values(targets.map((target, position) => ({ ...target, poolId: found.id, position })));
      }
      // So the pool reads as changed: a model list cached for it is stale.
      const [touched] = await tx.update(pools).set({ updatedAt: new Date() }).where(eq(pools.id, found.id)).returning();
      return touched ?? found;
    });
    await ctx.snapshot.rebuild();
    return pool;
  };

  return extended;
}
