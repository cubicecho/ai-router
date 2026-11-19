import { z } from 'zod';
import { ADMIN_ROLES, AdminRole } from '../core/admin-roles.ts';
import { CHILD_DEFAULTS, TOOL_CONFIG_DEFAULTS } from '../core/defaults.ts';
import { nameSchema } from '../core/names.ts';
import { SecretKind } from '../db/tables/server-secrets.ts';
import { routerGroups } from './child-users.ts';
import { externalTransportSchema, serverNameSchema } from './shapes.ts';

const { uidMin, uidMax, firstExtraGid, maxExtraGid, maxExtraGroups } = CHILD_DEFAULTS;

const {
  maxEnvVars,
  maxEnvValueLength,
  maxArgs,
  maxArgLength,
  maxHeaders,
  maxSecretLength,
  maxTimeoutMs,
  maxDisplayNameLength,
  maxDescriptionLength,
} = TOOL_CONFIG_DEFAULTS;

/** An env var's name, as a shell would take it. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** An HTTP header name: RFC 9110's token characters. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** What a header value may not hold: a line break would start another header. */
const LINE_BREAK = /[\r\n]/;
/** What no env value or argument may hold: the C strings a program gets end at the first one. */
const NUL = '\0';
/** The address schemes an HTTP server may have. */
const WEB_PROTOCOLS = ['http:', 'https:'];

/** An http or https address. */
export const webUrl = z
  .string()
  .trim()
  .refine((value) => URL.canParse(value) && WEB_PROTOCOLS.includes(new URL(value).protocol), {
    error: 'The address must be an http or https URL.',
  });

/** Env values by name, not secret. */
export const envInput = z
  .record(
    z.string().regex(ENV_NAME, 'An env var name holds letters, digits and _, and does not start with a digit.'),
    z
      .string()
      .max(maxEnvValueLength, 'An env value is too long.')
      .refine((value) => value.includes(NUL) === false, { error: 'An env value cannot hold a NUL.' }),
  )
  .refine((value) => Object.keys(value).length <= maxEnvVars, { error: `At most ${maxEnvVars} env vars.` });

/** A stdio server's arguments. */
export const argsInput = z
  .array(
    z
      .string()
      .max(maxArgLength, 'An argument is too long.')
      .refine((value) => value.includes(NUL) === false, { error: 'An argument cannot hold a NUL.' }),
  )
  .max(maxArgs, `At most ${maxArgs} arguments.`);

/**
 * A server's extra groups, by the rules `run-as-child` enforces itself, so a person reads why before the helper
 * refuses to start the server.
 */
export const extraGroupsInput = z
  .array(
    z
      .number()
      .int('A group id is a whole number.')
      .min(firstExtraGid, `Groups below ${firstExtraGid} are the system's own, root and shadow among them.`)
      .max(maxExtraGid, `A group id is at most ${maxExtraGid}.`)
      .refine((gid) => gid < uidMin || gid > uidMax, {
        error: `Groups ${uidMin}–${uidMax} belong to servers: holding one would open another server's folder.`,
      })
      .refine((gid) => routerGroups().includes(gid) === false, {
        error: "That is one of the router's own groups.",
      }),
  )
  .max(maxExtraGroups, `At most ${maxExtraGroups} extra groups.`)
  .refine((groups) => new Set(groups).size === groups.length, { error: 'A group is listed twice.' });

/** A timeout a server sets for itself. Null for the router's default. */
const timeoutInput = z
  .number()
  .int()
  .positive('A timeout is more than 0.')
  .max(maxTimeoutMs, `A timeout is at most ${maxTimeoutMs} ms.`)
  .nullable();

/** A transport a person gives a server, with the limits on its command and arguments. Never the built-in one. */
export const transportInput = externalTransportSchema.superRefine((transport, issues) => {
  if (transport.type === 'stdio') {
    const checked = argsInput.safeParse([transport.command, ...transport.args]);
    if (checked.success === false) {
      issues.addIssue({ code: 'custom', message: checked.error.issues[0]?.message ?? 'Bad command.' });
    }
    return;
  }
  if (webUrl.safeParse(transport.url).success === false) {
    issues.addIssue({ code: 'custom', message: 'The address must be an http or https URL.' });
  }
});

/**
 * A server's columns as an update states them. Strict, so the columns the router keeps itself (its
 * user id, folder, source and login) can't be written.
 */
export const serverUpdateInput = z
  .object({
    name: serverNameSchema,
    displayName: z.string().trim().max(maxDisplayNameLength, 'Display name is too long.').nullable(),
    description: z.string().max(maxDescriptionLength, 'Description is too long.'),
    enabled: z.boolean(),
    transport: transportInput,
    env: envInput,
    envMeta: z.record(z.string(), z.unknown()),
    idleTimeoutMs: timeoutInput,
    callTimeoutMs: timeoutInput,
    extraGroups: extraGroupsInput,
    // Set by drizzle on every update.
    updatedAt: z.unknown(),
  })
  .partial()
  .strict();

/** A registry as a write states it. */
export const registryInput = z
  .object({ name: nameSchema('Name'), url: webUrl })
  .partial()
  .strict();

/** What an entry for the admin server grants its workspace's runs: roles from the vocabulary, each once. */
export const rolesInput = z
  .array(z.enum(AdminRole, { error: `A role is one of ${ADMIN_ROLES.join(', ')}.` }))
  .refine((roles) => new Set(roles).size === roles.length, { error: 'A role is listed twice.' });

/** A server entry as a write states it. Which workspace and server it joins are set once. */
export const workspaceServerInput = z
  .object({
    workspaceId: z.uuid(),
    serverId: z.uuid(),
    env: envInput,
    args: argsInput.nullable(),
    url: webUrl.nullable(),
    roles: rolesInput,
    updatedAt: z.unknown(),
  })
  .partial()
  .strict();

/** What a bad header name is told. */
const HEADER_NAME_RULE = 'A header name holds letters, digits and - only.';
/** What a header value with a line break is told. */
const HEADER_VALUE_RULE = 'A header value cannot hold a line break.';

/** A secret's value, of either kind. */
const secretValue = z
  .string()
  .max(maxSecretLength, 'That secret is too long.')
  .refine((value) => value.includes(NUL) === false, { error: 'A secret cannot hold a NUL.' });

/** What `setServerSecret` takes. */
export const secretInput = z
  .object({
    kind: z.enum([SecretKind.Env, SecretKind.Header]),
    name: z.string().min(1, 'Name the env var or header.'),
    /** Null or empty clears it. */
    value: secretValue.nullable(),
  })
  .superRefine((secret, issues) => {
    const isEnv = secret.kind === SecretKind.Env;
    const nameOk = (isEnv ? ENV_NAME : HEADER_NAME).test(secret.name);
    if (nameOk === false) {
      issues.addIssue({
        code: 'custom',
        message: isEnv
          ? 'An env var name holds letters, digits and _, and does not start with a digit.'
          : HEADER_NAME_RULE,
      });
    }
    if (isEnv === false && secret.value !== null && LINE_BREAK.test(secret.value)) {
      issues.addIssue({ code: 'custom', message: HEADER_VALUE_RULE });
    }
  });

/**
 * The secret headers a server is added with, checked as `setServerSecret` checks a header. Each needs a value, and a
 * name is given once, whatever its case, since HTTP reads `Authorization` and `authorization` as one header.
 */
export const secretHeadersInput = z
  .array(
    z.object({
      name: z.string().regex(HEADER_NAME, HEADER_NAME_RULE),
      value: secretValue
        .min(1, 'Give the header a value.')
        .refine((value) => LINE_BREAK.test(value) === false, { error: HEADER_VALUE_RULE }),
    }),
  )
  .max(maxHeaders, `At most ${maxHeaders} headers.`)
  .refine((headers) => new Set(headers.map((header) => header.name.toLowerCase())).size === headers.length, {
    error: 'A header is listed twice.',
  });

/** How many secrets of one kind a server, or one workspace's entry for it, may hold. */
export const SECRET_LIMITS = Object.freeze({ [SecretKind.Env]: maxEnvVars, [SecretKind.Header]: maxHeaders });
