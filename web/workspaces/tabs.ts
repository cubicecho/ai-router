/** A workspace page's tabs, the default first: what its apps may run, how they call, its MCP Servers, what they used. */
export const WORKSPACE_TABS = ['agents', 'keys', 'mcp', 'usage'] as const;

/** One of a workspace page's tabs. */
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
