import { tabSearch } from '../lib/tab-search';

/**
 * Every tab an MCP server's page can have, the default first. Not every server has all of them: the admin server
 * has no Secrets or Login, and only a remote server has a Login.
 */
export const SERVER_TABS = ['overview', 'tools', 'instances', 'secrets', 'login', 'activity'] as const;
export type ServerTab = (typeof SERVER_TABS)[number];

/** The server route's `validateSearch`: the open tab, checked against every tab a server can have. */
export const validateServerSearch = tabSearch(SERVER_TABS);

/** What decides which tabs a server's page has. */
export interface ServerTabsOf {
  isBuiltin: boolean;
  hasLogin: boolean;
}

/**
 * Lists the tabs one server's page has.
 *
 * @param server - Whether it is the admin server, and whether it has a login.
 * @returns Its tabs, in the order they are drawn.
 */
export function serverTabsOf({ isBuiltin, hasLogin }: ServerTabsOf): ServerTab[] {
  return SERVER_TABS.filter((tab) => {
    if (tab === 'secrets') {
      return isBuiltin === false;
    }
    if (tab === 'login') {
      return hasLogin;
    }
    return true;
  });
}

/** The MCP Servers page's tabs, the default first: the servers, and the registries they are installed from. */
export const SERVERS_PAGE_TABS = ['servers', 'registries'] as const;
export type ServersPageTab = (typeof SERVERS_PAGE_TABS)[number];

/** What each of the MCP Servers page's tabs is called. */
export const SERVERS_PAGE_TAB_LABELS: Readonly<Record<ServersPageTab, string>> = {
  servers: 'Servers',
  registries: 'Registries',
};

/** The MCP Servers route's `validateSearch`: the open tab. */
export const validateServersSearch = tabSearch(SERVERS_PAGE_TABS);
