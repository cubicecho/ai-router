import { z } from 'zod';
import { WORKSPACE_DEFAULTS } from '../core/defaults.ts';
import { nameSchema } from '../core/names.ts';

const { maxNameLength, maxDescriptionLength, maxKeyNameLength, maxKeyExpiryDays } = WORKSPACE_DEFAULTS;

/** A workspace's columns as a write states them. Partial, since an update's `set` carries only what changed. */
export const workspaceInput = z
  .object({
    slug: nameSchema('Slug'),
    name: z.string().trim().min(1, 'Name cannot be empty.').max(maxNameLength, 'Name is too long.'),
    description: z.string().max(maxDescriptionLength, 'Description is too long.'),
  })
  .partial();

/** What making a key takes. */
export const keyInput = z.object({
  name: z.string().trim().min(1, 'A key needs a name.').max(maxKeyNameLength, 'Key name is too long.'),
  /** null or absent for a key that never expires. */
  expiresInDays: z
    .number()
    .int('Expiry is a whole number of days.')
    .min(1, 'A key that expires lasts at least a day.')
    .max(maxKeyExpiryDays, `A key may last at most ${maxKeyExpiryDays} days.`)
    .nullish(),
});
