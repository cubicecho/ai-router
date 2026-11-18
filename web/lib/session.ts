/** Where the UI keeps its session token. A bearer token, never a cookie. */
const SESSION_KEY = 'ai-router.session';

/**
 * Reads the session token the UI signed in with.
 *
 * @returns The token, or null when signed out or when storage is unavailable.
 */
export function sessionToken(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

/**
 * Keeps a new session token.
 *
 * @param token - The token a sign-in answered with.
 */
export function keepSession(token: string): void {
  localStorage.setItem(SESSION_KEY, token);
}

/** Forgets the session token, signing the UI out. */
export function forgetSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing kept, so nothing to forget.
  }
}
