import { useMutation, useQuery } from '@tanstack/react-query';
import { createLink, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Fragment } from 'react';
import { MeDocument, SignOutDocument } from '@/__generated__/graphql';
import { AppBarItem, Sidebar, SidebarItem, SidebarSection } from '@/components/sidebar';
import { SidebarLayout } from '@/components/split-layout';
import {
  Activity,
  Bot,
  KeyRound,
  Layers,
  ListChecks,
  LogOut,
  Plug,
  Route,
  Server,
  Settings,
  UserRound,
} from '@/components/ui/icons';
import { Separator } from '@/components/ui/separator';
import { request } from '@/lib/gql';
import { Role } from '@/lib/roles';
import { forgetSession } from '@/lib/session';

/** One of the sidebar's places. */
interface Place {
  to: string;
  label: string;
  icon: typeof Bot;
}

/**
 * The places every user has, in groups the sidebar divides with a rule: what ran, what does the work, and what the
 * work runs on.
 */
const PLACE_GROUPS: readonly { label: string; places: readonly Place[] }[] = [
  { label: 'Runs', places: [{ to: '/agent-runs', label: 'Runs', icon: Activity }] },
  {
    label: 'Agents',
    places: [
      { to: '/agents', label: 'Agents', icon: Bot },
      { to: '/workspaces', label: 'Workspaces', icon: KeyRound },
      { to: '/policies', label: 'Policies', icon: ListChecks },
    ],
  },
  {
    label: 'Servers and models',
    places: [
      { to: '/mcp-servers', label: 'MCP Servers', icon: Plug },
      { to: '/providers', label: 'Providers', icon: Server },
      { to: '/pools', label: 'Pools', icon: Layers },
    ],
  },
];
/**
 * The places only an admin has, at the foot of the sidebar with Sign out. Anyone else who opens Settings reads it, so
 * it is not offered to them.
 */
const ADMIN_PLACES: readonly Place[] = [
  { to: '/users', label: 'Users', icon: UserRound },
  { to: '/settings', label: 'Settings', icon: Settings },
];

// The row and the bar's icon name no router; the router supplies the `href` and the click.
const SidebarLink = createLink(SidebarItem);
const BarLink = createLink(AppBarItem);

/** The router's name at the top of the sidebar. */
function Brand() {
  return (
    <div className="flex items-center gap-2 px-2 py-1 font-semibold text-sm tracking-tight">
      <Route className="size-4" />
      ai-router
    </div>
  );
}

/** The frame every signed-in page renders inside: the sidebar on a wide screen, a bar on a narrow one. */
export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const me = useQuery({ queryKey: ['me'], queryFn: () => request(MeDocument) });
  const isAdmin = me.data?.me.role === Role.Admin;
  const adminPlaces = isAdmin ? ADMIN_PLACES : [];
  // The phone's bar has no groups or foot: every place, in the sidebar's order.
  const barPlaces = [...PLACE_GROUPS.flatMap((group) => group.places), ...adminPlaces];
  const isActive = (to: string): boolean => pathname.startsWith(to);
  const signOutLabel = me.data === undefined ? 'Sign out' : `Sign out ${me.data.me.name ?? me.data.me.email}`;

  const signOut = useMutation({
    mutationFn: () => request(SignOutDocument),
    // Signed out here whatever the server said: the token is the UI's to drop.
    onSettled: () => {
      forgetSession();
      void navigate({ to: '/login' });
    },
    meta: { quiet: true },
  });

  return (
    <SidebarLayout
      className="h-svh w-screen overflow-hidden bg-background text-foreground"
      sidebarPosition="start"
      sidebarWidth="auto"
      divider="none"
      sidebarHideBelow="md"
      sidebarSlot={
        <Sidebar
          label="Main"
          headerSlot={<Brand />}
          contentSlot={PLACE_GROUPS.map((group, index) => (
            <Fragment key={group.label}>
              {index > 0 ? <Separator className="my-2" /> : null}
              <SidebarSection
                as="nav"
                label={group.label}
                contentSlot={group.places.map(({ to, label, icon: Icon }) => (
                  <SidebarLink key={to} to={to} label={label} iconSlot={<Icon />} active={isActive(to)} />
                ))}
              />
            </Fragment>
          ))}
          footerSlot={
            <>
              {adminPlaces.map(({ to, label, icon: Icon }) => (
                <SidebarLink key={to} to={to} label={label} iconSlot={<Icon />} active={isActive(to)} />
              ))}
              <SidebarItem label={signOutLabel} iconSlot={<LogOut />} onClick={() => signOut.mutate()} />
            </>
          }
        />
      }
      brandSlot={<Route className="size-4" aria-label="ai-router" />}
      navSlot={barPlaces.map(({ to, label, icon: Icon }) => (
        <BarLink key={to} to={to} label={label} iconSlot={<Icon />} active={isActive(to)} />
      ))}
      navLabel="Main"
      actionSlot={<AppBarItem label="Sign out" iconSlot={<LogOut />} onClick={() => signOut.mutate()} />}
      contentSlot={<Outlet />}
    />
  );
}
