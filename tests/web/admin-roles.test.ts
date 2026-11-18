import { describe, expect, it } from 'vitest';
import { ADMIN_ROLES } from '../../server/core/admin-roles.ts';
import { ADMIN_ROLE_CHOICES, checkedRoles, describeRoles, roleChecksOf, rolesOf } from '../../web/tools/admin-roles.ts';

// The UI keeps its own copy of the role vocabulary, with a line on each, so this keeps it the router's.

describe("the UI's admin roles", () => {
  it("are the router's roles, in its order", () => {
    expect(ADMIN_ROLE_CHOICES.map((choice) => choice.role)).toEqual([...ADMIN_ROLES]);
  });

  it('read back what the checkboxes hold, and skip a role the UI does not know', () => {
    const roles = rolesOf(['runs:read', 'agents:read', 'agents:delete', null]);
    expect(roles).toEqual(['agents:read', 'runs:read']);
    expect(checkedRoles(roleChecksOf(roles))).toEqual(roles);
    expect(describeRoles(roles)).toBe('Roles: Read agents, Read runs');
  });
});
