import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from '@/components/app-shell';
import { sessionToken } from '@/lib/session';

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
    throw redirect({ to: '/workspaces' });
  },
});

const workspacesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/workspaces',
  component: lazyRouteComponent(() => import('@/routes/workspaces'), 'WorkspacesRoute'),
});

const workspaceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/workspaces/$workspaceId',
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
  component: lazyRouteComponent(() => import('@/routes/pool'), 'PoolRoute'),
});

const serversRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/servers',
  component: lazyRouteComponent(() => import('@/routes/servers'), 'ServersRoute'),
});

const serverRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/servers/$serverId',
  component: lazyRouteComponent(() => import('@/routes/server'), 'ServerRoute'),
});

const usersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/users',
  component: lazyRouteComponent(() => import('@/routes/users'), 'UsersRoute'),
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    loginRoute,
    ssoRoute,
    appRoute.addChildren([
      indexRoute,
      workspacesRoute,
      workspaceRoute,
      providersRoute,
      providerRoute,
      poolsRoute,
      poolRoute,
      serversRoute,
      serverRoute,
      usersRoute,
    ]),
  ]),
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
