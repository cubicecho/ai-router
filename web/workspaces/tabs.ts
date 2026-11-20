/**
 * A workspace page's tabs, the default first: what it is, what its apps may run, how they call, its MCP Servers, the
 * runs its apps started, and what they used.
 */
export const WORKSPACE_TABS = ['overview', 'agents', 'keys', 'mcp', 'runs', 'usage'] as const;

/** One of a workspace page's tabs. */
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
