import type { Request } from 'express';

/**
 * Copies Express's headers into a fetch `Headers`, as the caller readers take them.
 *
 * @param request - The request.
 * @returns Its headers.
 */
export function headersOf(request: Request): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      headers.set(name, value.join(', '));
    }
  }
  return headers;
}
