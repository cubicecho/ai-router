import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { Context } from '../core/context.ts';
import { ROUTER_CONFIG_DEFAULTS, ROUTER_DEFAULTS } from '../core/defaults.ts';
import {
  changedSettings,
  MIN_APP_TOOLS,
  routerSettingsFrom,
  type SavedSettings,
  savedSettingsFrom,
  settingsChangeSchema,
} from '../core/settings.ts';
import { parseOrThrow } from '../core/validation.ts';
import type { DB, Transaction } from '../db/client.ts';
import { settings } from '../db/tables/settings.ts';
import { objectType } from '../graphql/object-type.ts';

const SETTINGS_SDL = parse(`
  "A whole-number setting: what is in force, what an admin saved, and the range it may be set within."
  type IntSetting {
    "The value in force: the saved one, or the default when none is saved."
    value: Int!
    "What an admin saved, or null when the setting follows its default."
    saved: Int
    "What it is when nobody has set it."
    default: Int!
    "The lowest it may be set to."
    min: Int!
    "The highest it may be set to."
    max: Int!
  }

  "A setting that is on or off: what is in force, what an admin saved, and its default."
  type BooleanSetting {
    "The value in force: the saved one, or the default when none is saved."
    value: Boolean!
    "What an admin saved, or null when the setting follows its default."
    saved: Boolean
    "What it is when nobody has set it."
    default: Boolean!
  }

  "What a request on /v1 gets for a field its agent locks, or a stream_options key the router doesn't read."
  enum UnlistedFields {
    "Answer 400, naming the field."
    refuse
    "Drop the field, run the agent, and name it in the answer's X-AI-Router-Ignored header."
    ignore
  }

  "The choice for unlisted request fields: what is in force, what an admin saved, and its default."
  type UnlistedFieldsSetting {
    "The choice in force: the saved one, or the default when none is saved."
    value: UnlistedFields!
    "What an admin saved, or null when the setting follows its default."
    saved: UnlistedFields
    "What it is when nobody has set it."
    default: UnlistedFields!
  }

  "The router's settings, which an admin changes while it runs. Every user may read them."
  type RouterSettings {
    "The most tools an app may send with one request on /v1. OpenAI's own limit is 128."
    maxAppTools: IntSetting!
    """
    Whether an app tool that is one of the agent's own under another server's name is dropped: the same tool name
    after __, and the same input schema. An app tool with exactly the name of one of the agent's tools is always
    dropped. Off by default, since it is a guess; every drop is logged.
    """
    pruneAppToolsAcrossServers: BooleanSetting!
    "What a request on /v1 gets for a stream_options key other than include_usage, which the router doesn't read. Every other field the router doesn't read goes to the agent's model."
    unlistedFields: UnlistedFieldsSetting!
  }

  "A change to the router's settings. A field left out stays as it is, and null returns it to its default."
  input RouterSettingsInput {
    maxAppTools: Int
    pruneAppToolsAcrossServers: Boolean
    unlistedFields: UnlistedFields
  }

  extend type Query {
    "The router's settings."
    routerSettings: RouterSettings!
  }

  extend type Mutation {
    "Changes the router's settings. Admin only. Apps' next requests use them."
    updateRouterSettings(input: RouterSettingsInput!): RouterSettings!
  }
`);

/**
 * Reads what an admin saved.
 *
 * @param db - The database, or the transaction to read in.
 * @returns The members set. None when there is no row.
 */
async function readSaved(db: DB | Transaction): Promise<SavedSettings> {
  const [row] = await db.select({ values: settings.values }).from(settings);
  return savedSettingsFrom(row?.values);
}

/**
 * Builds the `RouterSettings` answer.
 *
 * @param saved - The members an admin set.
 * @returns Each setting with its value in force, what was saved, its default and its range.
 */
function settingsAnswer(saved: SavedSettings) {
  const current = routerSettingsFrom(saved);
  return {
    maxAppTools: {
      value: current.maxAppTools,
      saved: saved.maxAppTools ?? null,
      default: ROUTER_DEFAULTS.maxAppTools,
      min: MIN_APP_TOOLS,
      max: ROUTER_CONFIG_DEFAULTS.maxAppToolsLimit,
    },
    pruneAppToolsAcrossServers: {
      value: current.pruneAppToolsAcrossServers,
      saved: saved.pruneAppToolsAcrossServers ?? null,
      default: ROUTER_DEFAULTS.pruneAppToolsAcrossServers,
    },
    unlistedFields: {
      value: current.unlistedFields,
      saved: saved.unlistedFields ?? null,
      default: ROUTER_DEFAULTS.unlistedFields,
    },
  };
}

/**
 * Adds the router's settings: a read for every user, and a change for an admin (graphql/permissions).
 *
 * @param schema - The schema so far.
 * @returns The schema with them.
 */
export function applySettingsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, SETTINGS_SDL);
  const queries = objectType(extended, 'Query').getFields();
  const mutations = objectType(extended, 'Mutation').getFields();

  queries.routerSettings.resolve = async (_parent: unknown, _args: unknown, ctx: Context) =>
    settingsAnswer(await readSaved(ctx.db));

  mutations.updateRouterSettings.resolve = async (_parent: unknown, args: { input: unknown }, ctx: Context) => {
    const change = parseOrThrow(settingsChangeSchema, args.input);
    const saved = await ctx.db.transaction(async (tx) => {
      const next = changedSettings(await readSaved(tx), change);
      await tx
        .insert(settings)
        .values({ values: next })
        .onConflictDoUpdate({ target: settings.id, set: { values: next, updatedAt: new Date() } });
      return next;
    });
    // Before answering, so the app's next request is checked against the new settings.
    await ctx.snapshot.rebuild();
    return settingsAnswer(saved);
  };

  return extended;
}
