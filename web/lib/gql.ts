import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import { print } from 'graphql';
import { sessionToken } from './session.ts';

/** The UI calls its own origin; Vite proxies `/graphql` to the server in development. */
const ENDPOINT = '/graphql';

/** The code the server answers a missing or expired session with. */
export const UNAUTHENTICATED = 'UNAUTHENTICATED';

/** One error in a GraphQL answer, as far as the UI reads it. */
interface GraphQLErrorBody {
  message: string;
  extensions?: { code?: string };
}

/** A GraphQL answer. */
interface GraphQLResponse<T> {
  data?: T | null;
  errors?: GraphQLErrorBody[];
}

/** A refusal or failure the server reported, with its code for the UI to branch on. */
export class RequestError extends Error {
  /** `extensions.code`, such as `UNAUTHENTICATED` or `BAD_USER_INPUT`. Empty when there was none. */
  readonly code: string;

  /**
   * Builds the error from the answer's first error.
   *
   * @param message - What the server said.
   * @param code - Its code.
   */
  constructor(message: string, code: string) {
    super(message);
    this.name = 'RequestError';
    this.code = code;
  }
}

/**
 * Sends one operation, typed by its document, with the session as a bearer token.
 *
 * @typeParam TResult - What the operation answers.
 * @typeParam TVariables - What it takes.
 * @param document - The operation, from codegen.
 * @param variables - Its variables; left out for an operation that takes none.
 * @returns The answer's `data`.
 * @throws {@link RequestError} With the first error's message and code.
 */
export async function request<TResult, TVariables>(
  document: TypedDocumentNode<TResult, TVariables>,
  ...[variables]: TVariables extends Record<string, never> ? [] : [TVariables]
): Promise<TResult> {
  const token = sessionToken();
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ query: print(document), variables }),
  });
  const body: GraphQLResponse<TResult> = await response.json();
  const [first] = body.errors ?? [];
  if (first !== undefined) {
    throw new RequestError(first.message, first.extensions?.code ?? '');
  }
  if (body.data === undefined || body.data === null) {
    throw new RequestError(`The server answered with no data (HTTP ${response.status}).`, '');
  }
  return body.data;
}

/**
 * Whether a failure means the session is gone.
 *
 * @param error - What a request threw.
 * @returns true for UNAUTHENTICATED.
 */
export function isSignedOut(error: unknown): boolean {
  return error instanceof RequestError && error.code === UNAUTHENTICATED;
}
