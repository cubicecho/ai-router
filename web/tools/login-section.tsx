import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { type ServerFieldsFragment, SignOutServerDocument, StartServerLoginDocument } from '@/__generated__/graphql';
import { PropertyList, PropertyRow } from '@/components/property-list';
import { Section } from '@/components/section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KeyRound, LogOut, Settings } from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { request } from '@/lib/gql';
import { LoginClientDialog } from './login-client-dialog';

/** The `type` of the message the router's login callback page posts to the window that opened it. */
const LOGIN_MESSAGE_TYPE = 'ai-router-server-login';
/** The popup's window name, so a second Sign in reuses it rather than opening another. */
const POPUP_NAME = 'ai-router-server-login';
/** The popup's size and the flag that makes it one. */
const POPUP_FEATURES = 'popup,width=600,height=720';
/** How often to look whether the popup was closed without a word. */
const POPUP_POLL_MS = 500;

/** A remote server's login, as the server query serves it. */
type Login = NonNullable<ServerFieldsFragment['login']>;

/** What the login callback page says. */
interface LoginMessage {
  type: typeof LOGIN_MESSAGE_TYPE;
  serverId: string | null;
  serverName: string | null;
  ok: boolean;
  error: string | null;
}

/**
 * Whether a posted message is the login callback's.
 *
 * @param data - The message's data.
 * @returns true for the callback's message.
 */
function isLoginMessage(data: unknown): data is LoginMessage {
  return typeof data === 'object' && data !== null && 'type' in data && data.type === LOGIN_MESSAGE_TYPE;
}

/**
 * Whether a remote server is signed in, as a badge. Draws nothing for one the router starts.
 *
 * @remarks
 * Not signed in is no warning: most servers ask for no login, and the router can't tell which do until one
 * refuses a call. An instance that fails for want of one says so in its error.
 */
export function LoginBadge({
  login,
  showSignedOut = false,
}: {
  login: Login | null | undefined;
  showSignedOut?: boolean;
}) {
  if (login === null || login === undefined) {
    return null;
  }
  if (login.signedIn) {
    return <Badge variant="positive-soft">Signed in</Badge>;
  }
  return showSignedOut ? <Badge variant="outline">Not signed in</Badge> : null;
}

/** What the login section is given. */
export interface LoginSectionProps {
  server: ServerFieldsFragment & { login: Login };
  isAdmin: boolean;
}

/**
 * A remote server's login: whether the router is signed in, and the buttons that sign it in and out.
 * Signing in opens the login's page in a popup, which tells this page when it is done.
 */
export function LoginSection({ server, isAdmin }: LoginSectionProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [isSettingClient, setIsSettingClient] = useState(false);
  const popup = useRef<Window | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['servers'] });

  // The callback page posts to the window that opened it. It is on the router's own origin, which in
  // development is not the UI's, so the message is taken by who sent it: the popup this page opened.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== popup.current || isLoginMessage(event.data) === false) {
        return;
      }
      popup.current = null;
      void refresh();
      if (event.data.ok) {
        toast(`Signed in to ${event.data.serverName ?? server.name}.`, 'positive');
      } else {
        toast(event.data.error ?? 'The sign-in failed.');
      }
    };
    window.addEventListener('message', onMessage);
    // A popup closed by hand says nothing, so look now and then, and read the login again once it is gone.
    const timer = window.setInterval(() => {
      if (popup.current?.closed === true) {
        popup.current = null;
        void refresh();
      }
    }, POPUP_POLL_MS);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(timer);
    };
  });

  const signIn = useMutation({
    mutationFn: () => request(StartServerLoginDocument, { serverId: server.id }),
    onSuccess: ({ startServerLogin }) => {
      if (startServerLogin.authorizationUrl === null || startServerLogin.authorizationUrl === undefined) {
        popup.current?.close();
        popup.current = null;
        void refresh();
        return;
      }
      if (popup.current === null || popup.current.closed) {
        popup.current = window.open(startServerLogin.authorizationUrl, POPUP_NAME, POPUP_FEATURES);
      } else {
        popup.current.location.href = startServerLogin.authorizationUrl;
      }
      if (popup.current === null) {
        toast('The browser blocked the sign-in window. Let this site open popups, then try again.');
      }
    },
    onError: () => {
      popup.current?.close();
      popup.current = null;
    },
  });
  const signOut = useMutation({
    mutationFn: () => request(SignOutServerDocument, { serverId: server.id }),
    onSuccess: refresh,
  });
  const startSignIn = () => {
    // Opened in the click itself, before the request, so the browser doesn't take it for an unasked popup.
    popup.current = window.open('', POPUP_NAME, POPUP_FEATURES);
    signIn.mutate();
  };
  const { login } = server;

  return (
    <Section
      title="Sign-in"
      description="For a server that asks for a login. Sign in once; the router keeps the login and uses it for every run."
      actionSlot={
        <>
          {login.signedIn ? (
            <Button
              variant="outline"
              size="sm"
              iconSlot={<LogOut />}
              loading={signOut.isPending}
              onClick={() => signOut.mutate()}
              content="Sign out"
            />
          ) : null}
          <Button
            variant={login.signedIn ? 'outline' : 'info'}
            size="sm"
            iconSlot={<KeyRound />}
            loading={signIn.isPending}
            onClick={startSignIn}
            content={login.signedIn ? 'Sign in again' : 'Sign in'}
          />
        </>
      }
      contentSlot={
        <>
          <PropertyList
            contentSlot={
              <>
                <PropertyRow
                  label="Status"
                  value={<LoginBadge login={login} showSignedOut />}
                  hint={
                    login.expiresAt === null || login.expiresAt === undefined
                      ? undefined
                      : `The token runs out ${new Date(login.expiresAt).toLocaleString()}; the router refreshes it.`
                  }
                />
                <PropertyRow
                  label="Client"
                  value={login.clientRegistered ? 'Set' : 'None yet'}
                  hint={
                    login.clientRegistered
                      ? login.hasClientSecret
                        ? 'Typed by hand, with a secret.'
                        : 'Registered by the router, or typed by hand.'
                      : 'Most logins register one on the first sign-in. One that does not needs it typed in.'
                  }
                  actionSlot={
                    isAdmin ? (
                      <Button
                        variant="outline"
                        size="sm"
                        iconSlot={<Settings />}
                        onClick={() => setIsSettingClient(true)}
                        content="Client"
                      />
                    ) : undefined
                  }
                />
                {login.scope === null || login.scope === undefined ? null : (
                  <PropertyRow label="Scope" value={login.scope} valueClassName="font-mono" />
                )}
              </>
            }
          />
          {isAdmin ? (
            <LoginClientDialog
              open={isSettingClient}
              onOpenChange={setIsSettingClient}
              serverId={server.id}
              serverName={server.name}
              login={login}
            />
          ) : null}
        </>
      }
    />
  );
}
