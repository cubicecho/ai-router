import { useMutation, useQuery } from '@tanstack/react-query';
import { createLink, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { MeDocument, SignOutDocument } from '@/__generated__/graphql';
import { AppBarItem, Sidebar, SidebarItem, SidebarSection } from '@/components/sidebar';
import { SidebarLayout } from '@/components/split-layout';
import { Layers, LogOut, Route, UserRound } from '@/components/ui/icons';
import { request } from '@/lib/gql';
import { Role } from '@/lib/roles';
import { forgetSession } from '@/lib/session';

/** The places every user has. */
const PLACES = [{ to: '/workspaces', label: 'Workspaces', icon: Layers }] as const;
/** The places only an admin has. */
const ADMIN_PLACES = [{ to: '/users', label: 'Users', icon: UserRound }] as const;

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
  const places = isAdmin ? [...PLACES, ...ADMIN_PLACES] : PLACES;

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
          contentSlot={
            <SidebarSection
              as="nav"
              label="Main"
              contentSlot={places.map(({ to, label, icon: Icon }) => (
                <SidebarLink key={to} to={to} label={label} iconSlot={<Icon />} active={pathname.startsWith(to)} />
              ))}
            />
          }
          footerSlot={
            <SidebarItem
              label={me.data === undefined ? 'Sign out' : `Sign out ${me.data.me.name ?? me.data.me.email}`}
              iconSlot={<LogOut />}
              onClick={() => signOut.mutate()}
            />
          }
        />
      }
      brandSlot={<Route className="size-4" aria-label="ai-router" />}
      navSlot={places.map(({ to, label, icon: Icon }) => (
        <BarLink key={to} to={to} label={label} iconSlot={<Icon />} active={pathname.startsWith(to)} />
      ))}
      navLabel="Main"
      actionSlot={<AppBarItem label="Sign out" iconSlot={<LogOut />} onClick={() => signOut.mutate()} />}
      contentSlot={<Outlet />}
    />
  );
}
