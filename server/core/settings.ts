import { z } from 'zod';
import { ROUTER_CONFIG_DEFAULTS, ROUTER_DEFAULTS, type RouterSettings } from './defaults.ts';

// The router's settings are `ROUTER_DEFAULTS` with what an admin saved spread over them. The `settings` row holds
// only the members someone set, so a member nobody touched follows its default, even after the default changes.

const { maxAppToolsLimit } = ROUTER_CONFIG_DEFAULTS;

/** The fewest app tools the cap may allow: one, so the setting never shuts an app's tools off. */
export const MIN_APP_TOOLS = 1;

/** The app-tool cap, as an admin may set it. */
const maxAppToolsSchema = z
  .int('The most tools a request may send is a whole number.')
  .min(MIN_APP_TOOLS, `Let a request send at least ${MIN_APP_TOOLS} tool.`)
  .max(maxAppToolsLimit, `A request may send at most ${maxAppToolsLimit} tools.`);

/** Whether an app tool under another server's name is dropped, as an admin may set it. */
const pruneAcrossServersSchema = z.boolean('Send true or false for pruning app tools across servers.');

/** What a request on `/v1` gets for a `stream_options` key the router doesn't read. */
export const UnlistedFields = { Refuse: 'refuse', Ignore: 'ignore' } as const satisfies Record<
  string,
  RouterSettings['unlistedFields']
>;
export type UnlistedFields = (typeof UnlistedFields)[keyof typeof UnlistedFields];

/** The choice for unlisted fields, as an admin may set it. */
const unlistedFieldsSchema = z.enum(UnlistedFields, {
  error: `Choose ${Object.values(UnlistedFields).join(' or ')} for unlisted request fields.`,
});

/** What the `settings` row holds: the members an admin set. One left out follows its default. */
export const savedSettingsSchema = z
  .strictObject({
    maxAppTools: maxAppToolsSchema,
    unlistedFields: unlistedFieldsSchema,
    pruneAppToolsAcrossServers: pruneAcrossServersSchema,
  })
  .partial();
/** The members an admin set. */
export type SavedSettings = z.infer<typeof savedSettingsSchema>;

/** A change to the settings. A member left out stays as it is, and null returns it to its default. */
export const settingsChangeSchema = z
  .strictObject({
    maxAppTools: maxAppToolsSchema.nullable(),
    unlistedFields: unlistedFieldsSchema.nullable(),
    pruneAppToolsAcrossServers: pruneAcrossServersSchema.nullable(),
  })
  .partial();
/** A change to the settings, as parsed. */
export type SettingsChange = z.infer<typeof settingsChangeSchema>;

/**
 * Reads what the `settings` row holds.
 *
 * @param stored - The row's `values`, or undefined when there is no row.
 * @returns The members an admin set. A row the rules no longer accept, such as a cap over a lowered limit, counts as
 * nothing set, with a warning, so routing never stops over it.
 */
export function savedSettingsFrom(stored: unknown): SavedSettings {
  if (stored === undefined) {
    return {};
  }
  const parsed = savedSettingsSchema.safeParse(stored);
  if (parsed.success) {
    return parsed.data;
  }
  console.warn(
    `[settings] the saved settings are not valid, so the defaults apply: ${parsed.error.issues[0]?.message}`,
  );
  return {};
}

/**
 * Builds the settings in force.
 *
 * @param saved - The members an admin set.
 * @returns The defaults, with what was saved over them.
 */
export function routerSettingsFrom(saved: SavedSettings): RouterSettings {
  return { ...ROUTER_DEFAULTS, ...saved };
}

/**
 * Applies a change to what is saved.
 *
 * @param saved - The members an admin set.
 * @param change - The change, already parsed.
 * @returns What to save: the change over what was saved, with every member set to null left out.
 */
export function changedSettings(saved: SavedSettings, change: SettingsChange): SavedSettings {
  const merged = Object.entries({ ...saved, ...change }).filter(([, value]) => value !== null);
  return savedSettingsSchema.parse(Object.fromEntries(merged));
}
