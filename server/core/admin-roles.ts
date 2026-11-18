/**
 * What a workspace lets its agent runs do through the admin server `ai-router`. Roles add up, and a manage role
 * includes reading its own area. None reaches promoting, deleting an agent, secrets, settings, users and roles, or
 * workspaces and keys: those stay with people.
 */
export const AdminRole = {
  /** See agents and their revisions. */
  AgentsRead: 'agents:read',
  /** Create agents and save revisions, as drafts unless the agent has auto-promote. */
  AgentsManage: 'agents:manage',
  /** See providers and pools. */
  ModelsRead: 'models:read',
  /** Add, change and remove providers and pools, and a pool's targets. Never a provider's key. */
  ModelsManage: 'models:manage',
  /** See servers, their tools and registries. */
  ServersRead: 'servers:read',
  /** Install, change and remove servers and registries. Never a server's secrets or login client. */
  ServersManage: 'servers:manage',
  /** Restart a server, try one of its tools, and start or end its login. */
  ServersOperate: 'servers:operate',
  /** See the runs the agent's own workspace started. */
  RunsRead: 'runs:read',
} as const;
export type AdminRole = (typeof AdminRole)[keyof typeof AdminRole];

/** Every role, in the order the UI lists them. */
export const ADMIN_ROLES: readonly AdminRole[] = Object.freeze(Object.values(AdminRole));
