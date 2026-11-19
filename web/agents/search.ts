/** The agent page's tabs, the default first, as the address bar names them: `?tab=history`. */
export const AGENT_TABS = ['overview', 'drafts', 'history', 'workspaces', 'runs', 'usage'] as const;
export type AgentTab = (typeof AGENT_TABS)[number];

/** What each of the agent page's tabs is called. */
export const AGENT_TAB_LABELS: Readonly<Record<AgentTab, string>> = {
  overview: 'Overview',
  drafts: 'Drafts',
  history: 'History',
  workspaces: 'Workspaces',
  runs: 'Runs',
  usage: 'Usage',
};
