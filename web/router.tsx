import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AGENT_TABS } from '@/agents/search';
import { AppShell } from '@/components/app-shell';
import { sessionToken } from '@/lib/session';
import { tabSearch } from '@/lib/tab-search';
import { validatePoolSearch, validateProviderSearch } from '@/models/tabs';
import { RUN_TABS, validateRunsSearch } from '@/runs/search';
import { validateServerSearch, validateServersSearch } from '@/tools/server-tabs';
import { WORKSPACE_TABS } from '@/workspaces/tabs';

const rootRoute = createRootRoute({ component: Outlet });

/** The sign-in page: the provider's button, the trusted network, or pairing a provider. */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): { error?: string; next?: string } => ({
    error: typeof search.error === 'string' ? search.error : undefined,
    // Only a path on this origin, so a crafted link cannot send a fresh session elsewhere.
    next: typeof search.next === 'string' && /^\/(?!\/)/.test(search.next) ? search.next : undefined,
  }),
  component: lazyRouteComponent(() => import('@/routes/login'), 'LoginRoute'),
});

/** Where the OIDC callback lands, with a one-time token to spend. */
const ssoRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/sso',
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  component: lazyRouteComponent(() => import('@/routes/sso'), 'SsoRoute'),
});

/** Everything signed in, inside the shell. A missing session goes to sign-in before anything loads. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: ({ location }) => {
    if (sessionToken() === null) {
      throw redirect({ to: '/login', search: { next: location.href } });
    }
  },
  component: AppShell,
});

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: () => {
    throw redirect({ to: '/agents' });
  },
});

const agentsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/agents',
  component: lazyRouteComponent(() => import('@/routes/agents'), 'AgentsRoute'),
});

const agentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/agents/$agentId',
  validateSearch: tabSearch(AGENT_TABS),
  component: lazyRouteComponent(() => import('@/routes/agent'), 'AgentRoute'),
});

// Not `/runs`, which is the apps' API: a key reads its runs there from phase 7.
const runsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/agent-runs',
  validateSearch: validateRunsSearch,
  component: lazyRouteComponent(() => import('@/routes/runs'), 'RunsRoute'),
});

const runRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/agent-runs/$runId',
  validateSearch: tabSearch(RUN_TABS),
  component: lazyRouteComponent(() => import('@/routes/run'), 'RunRoute'),
});

const workspacesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/workspaces',
  component: lazyRouteComponent(() => import('@/routes/workspaces'), 'WorkspacesRoute'),
});

const workspaceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/workspaces/$workspaceId',
  validateSearch: tabSearch(WORKSPACE_TABS),
  component: lazyRouteComponent(() => import('@/routes/workspace'), 'WorkspaceRoute'),
});

const providersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/providers',
  component: lazyRouteComponent(() => import('@/routes/providers'), 'ProvidersRoute'),
});

const providerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/providers/$providerId',
  validateSearch: validateProviderSearch,
  component: lazyRouteComponent(() => import('@/routes/provider'), 'ProviderRoute'),
});

const poolsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/pools',
  component: lazyRouteComponent(() => import('@/routes/pools'), 'PoolsRoute'),
});

const poolRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/pools/$poolId',
  validateSearch: validatePoolSearch,
  component: lazyRouteComponent(() => import('@/routes/pool'), 'PoolRoute'),
});

const serversRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/mcp-servers',
  validateSearch: validateServersSearch,
  component: lazyRouteComponent(() => import('@/routes/servers'), 'ServersRoute'),
});

const serverRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/mcp-servers/$serverId',
  validateSearch: validateServerSearch,
  component: lazyRouteComponent(() => import('@/routes/server'), 'ServerRoute'),
});

const usersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/users',
  component: lazyRouteComponent(() => import('@/routes/users'), 'UsersRoute'),
});

const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  component: lazyRouteComponent(() => import('@/routes/settings'), 'SettingsRoute'),
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    ssoRoute,
    appRoute.addChildren([
      indexRoute,
      agentsRoute,
      agentRoute,
      runsRoute,
      runRoute,
      workspacesRoute,
      workspaceRoute,
      providersRoute,
      providerRoute,
      poolsRoute,
      poolRoute,
      serversRoute,
      serverRoute,
      usersRoute,
      settingsRoute,
    ]),
  ]),
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
