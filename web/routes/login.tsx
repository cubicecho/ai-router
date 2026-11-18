import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { AuthConfigDocument, PairSsoDocument, SignInOnTrustedNetworkDocument } from '@/__generated__/graphql';
import { InputField, useAppForm } from '@/components/app-form';
import { CenteredCardLayout } from '@/components/centered-card-layout';
import { LoadError } from '@/components/load-state';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FormElement } from '@/components/ui/form-element';
import { KeyRound, TriangleAlert } from '@/components/ui/icons';
import { Spinner } from '@/components/ui/spinner';
import { request } from '@/lib/gql';
import { keepSession } from '@/lib/session';

/** What a failed provider sign-in says, whatever code the callback sent back. */
const SIGN_IN_FAILED = 'Signing in with your provider did not finish. Try again, or ask whoever runs the provider.';

/** Pastes a provider's setup URL, so the router registers itself there. Only offered while that is allowed. */
function PairProvider() {
  const queryClient = useQueryClient();
  const pair = useMutation({
    mutationFn: (setupUrl: string) => request(PairSsoDocument, { setupUrl }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['auth-config'] }),
  });
  const form = useAppForm({
    defaultValues: { setupUrl: '' },
    onSubmit: ({ value }) => pair.mutateAsync(value.setupUrl.trim()),
  });
  return (
    <form.AppForm>
      <FormElement onSubmit={() => form.handleSubmit()}>
        <InputField
          form={form}
          name="setupUrl"
          label="Setup URL"
          description="From your provider, such as heautou. The router registers itself there and the button appears here."
          required
          validators={{ onChange: ({ value }) => (value.trim() === '' ? 'Paste the setup URL.' : undefined) }}
        />
        <form.SubmitButton content="Connect provider" />
      </FormElement>
    </form.AppForm>
  );
}

/** The sign-in page: the provider's button, an automatic sign-in on a trusted network, or pairing a provider. */
export function LoginRoute() {
  const navigate = useNavigate();
  const { error, next } = useSearch({ from: '/login' });
  const config = useQuery({ queryKey: ['auth-config'], queryFn: () => request(AuthConfigDocument) });
  const trusted = useMutation({
    mutationFn: () => request(SignInOnTrustedNetworkDocument),
    // Said on the page, where the spinner was.
    meta: { quiet: true },
    onSuccess: ({ signInOnTrustedNetwork }) => {
      keepSession(signInOnTrustedNetwork.token);
      void navigate({ href: next ?? '/', replace: true });
    },
  });
  // Once: on a trusted network, opening the UI is signing in. Strict mode runs effects twice.
  const hasStarted = useRef(false);
  const isTrusted = config.data?.authConfig.trustedNetwork === true;
  useEffect(() => {
    if (isTrusted && hasStarted.current === false) {
      hasStarted.current = true;
      trusted.mutate();
    }
  }, [isTrusted, trusted]);

  if (config.isError) {
    return (
      <CenteredCardLayout
        title="Sign in"
        contentSlot={<LoadError error={config.error} onRetry={config.refetch} what="how to sign in" />}
      />
    );
  }
  const sso = config.data?.authConfig.sso ?? null;
  const canPair = config.data?.ssoSetup.canPair === true;

  return (
    <CenteredCardLayout
      iconSlot={<KeyRound />}
      title="Sign in to ai-router"
      description={isTrusted ? 'This router is on a trusted network, so opening it signs you in.' : undefined}
      loading={config.isPending}
      contentSlot={
        <>
          {error === undefined ? null : (
            <Alert variant="destructive" iconSlot={<TriangleAlert />} description={SIGN_IN_FAILED} />
          )}
          {isTrusted && trusted.isError === false ? <Spinner aria-label="Signing in" /> : null}
          {trusted.isError ? (
            <Alert
              variant="destructive"
              iconSlot={<TriangleAlert />}
              description={trusted.error.message}
              actionSlot={<Button variant="outline" size="sm" onClick={() => trusted.mutate()} content="Try again" />}
            />
          ) : null}
          {isTrusted === false && sso === null && canPair ? <PairProvider /> : null}
          {isTrusted === false && sso === null && canPair === false && config.data !== undefined ? (
            <Alert
              iconSlot={<TriangleAlert />}
              title="No way to sign in yet"
              description="Whoever runs this router needs to set OIDC_ISSUER, or SECURE_LOCAL_NET on a private network."
            />
          ) : null}
        </>
      }
      footerActionsSlot={
        sso === null || isTrusted ? undefined : (
          // A full-page navigation to the server, not a fetch: the provider's pages follow.
          <Button variant="default" linkSlot={<a href={sso.signInUrl} />} content={`Sign in with ${sso.name}`} />
        )
      }
    />
  );
}
