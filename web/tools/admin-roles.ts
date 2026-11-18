/** What a workspace's entry for the admin server can grant its agent runs, in the order the router lists them. */
export const ADMIN_ROLE_CHOICES = [
  { role: 'agents:read', label: 'Read agents', description: 'See agents and their revisions.' },
  {
    role: 'agents:manage',
    label: 'Manage agents',
    description: 'Create agents and save revisions, as drafts unless the agent has auto-promote.',
  },
  { role: 'models:read', label: 'Read models', description: 'See providers and pools.' },
  {
    role: 'models:manage',
    label: 'Manage models',
    description: "Add, change and remove providers and pools. Never a provider's key.",
  },
  { role: 'servers:read', label: 'Read servers', description: 'See servers, their tools and registries.' },
  {
    role: 'servers:manage',
    label: 'Manage servers',
    description: "Install, change and remove servers and registries. Never a server's secrets or login client.",
  },
  {
    role: 'servers:operate',
    label: 'Operate servers',
    description: 'Restart a server, try one of its tools, and start or end its login.',
  },
  { role: 'runs:read', label: 'Read runs', description: 'See the runs this workspace started.' },
] as const;

/** One role an entry for the admin server can grant. */
export type AdminRole = (typeof ADMIN_ROLE_CHOICES)[number]['role'];

/** Whether each role is granted, by role: what the entry dialog's checkboxes hold. */
export type RoleChecks = Record<AdminRole, boolean>;

/** Every box unchecked. Typed by the roles, so a role added above and missing here fails the build. */
const NO_ROLES: Readonly<RoleChecks> = Object.freeze({
  'agents:read': false,
  'agents:manage': false,
  'models:read': false,
  'models:manage': false,
  'servers:read': false,
  'servers:manage': false,
  'servers:operate': false,
  'runs:read': false,
});

/**
 * Reads an entry's `roles` as the roles the UI knows.
 *
 * @param value - The `roles` field, as the API serves it.
 * @returns The known roles in it, in the router's order.
 */
export function rolesOf(value: readonly (string | null)[] | null | undefined): AdminRole[] {
  const held = new Set(value ?? []);
  return ADMIN_ROLE_CHOICES.filter((choice) => held.has(choice.role)).map((choice) => choice.role);
}

/**
 * Says which roles an entry grants, in a few words.
 *
 * @param roles - The roles.
 * @returns Such as "Roles: Read agents, Read runs", or a line saying it grants none.
 */
export function describeRoles(roles: readonly AdminRole[]): string {
  const labels = ADMIN_ROLE_CHOICES.filter((choice) => roles.includes(choice.role)).map((choice) => choice.label);
  return labels.length === 0 ? 'No roles: its agent runs get no admin tools' : `Roles: ${labels.join(', ')}`;
}

/**
 * Turns roles into the dialog's checkboxes.
 *
 * @param roles - The roles granted.
 * @returns A box per role, checked for those granted.
 */
export function roleChecksOf(roles: readonly AdminRole[]): RoleChecks {
  const checks = { ...NO_ROLES };
  for (const role of roles) {
    checks[role] = true;
  }
  return checks;
}

/**
 * Turns the dialog's checkboxes back into roles.
 *
 * @param checks - A box per role.
 * @returns The checked roles, in the router's order.
 */
export function checkedRoles(checks: RoleChecks): AdminRole[] {
  return ADMIN_ROLE_CHOICES.filter((choice) => checks[choice.role]).map((choice) => choice.role);
}
