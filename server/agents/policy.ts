import { z } from 'zod';
import { OVERRIDE_POLICY_DEFAULTS } from '../core/defaults.ts';
import { nameSchema } from '../core/names.ts';

const { maxDescriptionLength, maxSamplingFields, maxFieldNameLength } = OVERRIDE_POLICY_DEFAULTS;

/** A request field's name, as OpenAI spells them on the wire. */
const FIELD_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * What the layers above an agent may change, as the `override_policies` table keeps it. Anything it does not allow
 * refuses the request, except an unlisted request field, which the router's `unlistedFields` setting may drop and name
 * instead. The model and the endpoint are never in it: no request changes them.
 */
export const overridePolicyRulesSchema = z.object({
  /** The app's leading system or developer messages become the agent's `host` prompt part. */
  hostPrompt: z.boolean(),
  /** `ai_router.task` becomes the agent's `task` prompt part. */
  taskPrompt: z.boolean(),
  /** A request may narrow the agent's servers. It never widens them, whatever this says. */
  narrowServers: z.boolean(),
  /** The OpenAI request fields an app may set, by their wire names. */
  sampling: z.array(z.string()),
  /** A request may send `response_format`. */
  responseFormat: z.boolean(),
});
export type OverridePolicyRules = z.infer<typeof overridePolicyRulesSchema>;

/** The seeded policy's rules: add instructions, narrow servers, set sampling; never change the model. */
export const DEFAULT_POLICY_RULES: OverridePolicyRules = Object.freeze({
  hostPrompt: true,
  taskPrompt: true,
  narrowServers: true,
  sampling: [
    'temperature',
    'max_tokens',
    'max_completion_tokens',
    'top_p',
    'top_k',
    'min_p',
    'presence_penalty',
    'frequency_penalty',
    'repetition_penalty',
    'seed',
    'stop',
    'repeat_penalty',
  ],
  responseFormat: true,
});

/**
 * Builds the schema for the fields a policy lets an app set: OpenAI's wire names, each once, and none the router
 * reads itself.
 *
 * @param readFields - The fields the router reads itself, which no policy makes an override.
 * @returns The zod schema, which trims each name before it checks.
 */
function samplingFieldsSchema(readFields: ReadonlySet<string>) {
  const field = z
    .string()
    .trim()
    .max(maxFieldNameLength, `A field name is longer than ${maxFieldNameLength} characters.`)
    .regex(FIELD_PATTERN, 'A field is named as OpenAI spells it: lowercase letters, digits and underscores.')
    .refine((name) => readFields.has(name) === false, {
      message: 'The router reads that field itself, so no policy lets a request set it.',
    });
  return z
    .array(field)
    .max(maxSamplingFields, `A policy lets an app set at most ${maxSamplingFields} fields.`)
    .refine((names) => new Set(names).size === names.length, { message: 'Name each field once.' });
}

/**
 * Builds the schema for a policy as a user writes it: a name, a description and its rules.
 *
 * @param readFields - The request fields the router reads itself.
 * @returns The zod schema.
 */
export function overridePolicyInputSchema(readFields: ReadonlySet<string>) {
  return z.object({
    name: nameSchema('Name'),
    description: z
      .string()
      .trim()
      .max(maxDescriptionLength, `Description is longer than ${maxDescriptionLength} characters.`)
      .nullish()
      .transform((description) => description ?? ''),
    rules: overridePolicyRulesSchema.extend({ sampling: samplingFieldsSchema(readFields) }).strict(),
  });
}
