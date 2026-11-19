import { z } from 'zod';
import { MODEL_CONFIG_DEFAULTS } from '../core/defaults.ts';
import { nameSchema } from '../core/names.ts';
import { EQUAL_WEIGHT } from '../db/tables/pool-targets.ts';

const {
  maxDisplayNameLength,
  maxDescriptionLength,
  maxHeaders,
  maxHeaderValueLength,
  maxApiKeyLength,
  maxTargets,
  maxTargetWeight,
  maxModelLength,
} = MODEL_CONFIG_DEFAULTS;

/** An HTTP header name: RFC 9110's token characters. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** What a header value may not hold: a line break would start another header. */
const LINE_BREAK = /[\r\n]/;
/** The base URL schemes a provider may have. */
const WEB_PROTOCOLS = ['http:', 'https:'];

const displayName = z.string().trim().max(maxDisplayNameLength, 'Display name is too long.').nullable();
const description = z.string().max(maxDescriptionLength, 'Description is too long.');

/** A provider's base URL: http or https. */
const baseUrl = z
  .string()
  .trim()
  .refine((value) => URL.canParse(value) && WEB_PROTOCOLS.includes(new URL(value).protocol), {
    error: 'Base URL must be an http or https URL, such as http://ollama:11434/v1.',
  });

/** A provider's extra headers. */
const headers = z
  .record(
    z.string().regex(HEADER_NAME, 'A header name holds letters, digits and - only.'),
    z
      .string()
      .max(maxHeaderValueLength, 'A header value is too long.')
      .refine((value) => LINE_BREAK.test(value) === false, { error: 'A header value cannot hold a line break.' }),
  )
  .refine((value) => Object.keys(value).length <= maxHeaders, {
    error: `A provider may send at most ${maxHeaders} headers.`,
  });

/** A provider's columns as a write states them. Partial, since an update's `set` carries only what changed. */
export const providerInput = z
  .object({ name: nameSchema('Name'), displayName, description, baseUrl, headers })
  .partial();

/** A provider's key. Null or empty clears it. */
export const apiKeyInput = z.string().trim().max(maxApiKeyLength, 'That key is too long.').nullable();

/** A pool's columns as a write states them. */
export const poolInput = z
  .object({
    name: nameSchema('Name'),
    displayName,
    description,
    maxLoadFactor: z.number().min(1, 'The load factor is at least 1: a target may hold its share.').nullable(),
  })
  .partial();

/** A pool's targets, in order. */
export const targetsInput = z
  .array(
    z.object({
      providerId: z.uuid('Pick a provider.'),
      model: z
        .string()
        .trim()
        .min(1, 'Name the model at the provider.')
        .max(maxModelLength, 'That model id is too long.'),
      weight: z
        .int('A weight is a whole number.')
        .min(EQUAL_WEIGHT, `A weight is at least ${EQUAL_WEIGHT}.`)
        .max(maxTargetWeight, `A weight is at most ${maxTargetWeight}.`),
    }),
  )
  .max(maxTargets, `A pool may have at most ${maxTargets} targets.`)
  .refine(
    (targets) => new Set(targets.map((target) => `${target.providerId}\n${target.model}`)).size === targets.length,
    { error: 'A pool lists each target once.' },
  );
