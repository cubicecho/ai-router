import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { VerifyOneTimeTokenDocument } from '@/__generated__/graphql';
import { CenteredCardLayout } from '@/components/centered-card-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { KeyRound, TriangleAlert } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/spinner';
import { request } from '@/lib/gql';
import { keepSession } from '@/lib/session';

/** Where the OIDC callback lands: spends its one-time token for a session, then opens the UI. */
export function SsoRoute() {
  const navigate = useNavigate();
  const { token } = useSearch({ from: '/auth/sso' });
  const verify = useMutation({
    mutationFn: (oneTime: string) => request(VerifyOneTimeTokenDocument, { token: oneTime }),
    onSuccess: ({ verifyOneTimeToken }) => {
      keepSession(verifyOneTimeToken.token);
      void navigate({ to: '/', replace: true });
    },
    meta: { quiet: true },
  });
  // Once: the token works a single time, and strict mode runs effects twice.
  const hasSpent = useRef(false);
  useEffect(() => {
    if (token !== undefined && hasSpent.current === false) {
      hasSpent.current = true;
      verify.mutate(token);
    }
  }, [token, verify]);

  const hasFailed = verify.isError || token === undefined;
  return (
    <CenteredCardLayout
      iconSlot={<KeyRound />}
      title={hasFailed ? 'Sign-in did not finish' : 'Signing in'}
      contentSlot={
        hasFailed ? (
          <Alert
            variant="destructive"
            iconSlot={<TriangleAlert />}
            description="A sign-in has to be finished within a few minutes, and only once. Start it again."
          />
        ) : (
          <Spinner aria-label="Signing in" />
        )
      }
      footerActionsSlot={
        hasFailed ? <Button variant="outline" linkSlot={<Link to="/login" />} content="Back to sign-in" /> : undefined
      }
    />
  );
}
