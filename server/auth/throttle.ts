import type { Context } from '../core/context.ts';

/** The sign-in steps that are throttled. Each has its own budget. */
export const AuthFlow = {
  VerifyOneTimeToken: 'verify-one-time-token',
  TrustedNetwork: 'trusted-network',
} as const;
export type AuthFlow = (typeof AuthFlow)[keyof typeof AuthFlow];

/**
 * Counts one sign-in attempt, and throws once the caller has made too many.
 *
 * @param context - The request's context, for its limiter and client IP.
 * @param flow - Which sign-in step this is.
 *
 * @remarks
 * By address alone: no sign-in step here names an account before it succeeds.
 */
export function throttle(context: Context, flow: AuthFlow): void {
  context.limiter.hit(`${flow}:ip:${context.ip}`);
}
