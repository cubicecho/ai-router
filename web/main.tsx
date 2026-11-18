import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider, useToast } from '@/components/ui/toast';
import { isSignedOut } from '@/lib/gql';
import { forgetSession } from '@/lib/session';
import { router } from '@/router';
import './index.css';

/** How long an unused answer stays cached, so a page returned to shows what it showed. */
const CACHE_MINUTES = 30;
const MS_PER_MINUTE = 60_000;

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: { quiet?: boolean };
  }
}

/**
 * Sends a signed-out UI to the sign-in page.
 *
 * @param error - What a request threw.
 * @returns true when it was a lost session, which needs no other message.
 */
function signOutOn(error: unknown): boolean {
  if (isSignedOut(error) === false) {
    return false;
  }
  forgetSession();
  void router.navigate({ to: '/login' });
  return true;
}

/** The query client, under the toast provider so a failed mutation can say so. */
function App() {
  const toast = useToast();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({ onError: (error) => signOutOn(error) }),
        // A mutation that says its failure somewhere better sets `meta: { quiet: true }`.
        mutationCache: new MutationCache({
          onError: (error, _variables, _context, mutation) => {
            const isHandled = signOutOn(error) || mutation.meta?.quiet === true;
            if (isHandled === false) {
              toast(error.message);
            }
          },
        }),
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false, staleTime: 0, gcTime: CACHE_MINUTES * MS_PER_MINUTE },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

const root = document.getElementById('root');
if (root === null) {
  throw new Error('#root is missing from index.html');
}

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
