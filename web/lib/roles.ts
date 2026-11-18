import type { UsersRoleEnum } from '@/__generated__/graphql';

/** What a user may do. An admin may also set secrets and settings, and give or take the admin role. */
export const Role = { Admin: 'admin', User: 'user' } as const satisfies Record<string, UsersRoleEnum>;
