import { GraphQLError } from 'graphql';
import { HttpStatus } from './wire.ts';

/** The `extensions.code` values clients branch on. */
export const ErrorCode = {
  Unauthenticated: 'UNAUTHENTICATED',
  NotFound: 'NOT_FOUND',
  BadUserInput: 'BAD_USER_INPUT',
  TooManyRequests: 'TOO_MANY_REQUESTS',
  QueryTooComplex: 'QUERY_TOO_COMPLEX',
  Forbidden: 'FORBIDDEN',
  Conflict: 'CONFLICT',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Makes an error factory for one code.
 *
 * @param code - The `extensions.code` value.
 * @returns A function from message to GraphQLError.
 */
const withCode =
  (code: ErrorCode) =>
  (message: string): GraphQLError =>
    new GraphQLError(message, { extensions: { code } });

/** Arguments the caller can fix. */
export const badInput = withCode(ErrorCode.BadUserInput);
/** No such row. */
export const notFound = withCode(ErrorCode.NotFound);
/** Nobody is signed in, or the session has run out. */
export const unauthenticated = withCode(ErrorCode.Unauthenticated);
/** This kind of caller may never do this: a user reaching for what only an admin may, or a key on /graphql. */
export const forbidden = withCode(ErrorCode.Forbidden);
/** The request is fine, but the router is in a state that refuses it, such as demoting the last admin. */
export const conflict = withCode(ErrorCode.Conflict);

/**
 * Builds the rate-limit refusal.
 *
 * @param message - What the caller is told.
 * @param retryAfter - Seconds until the next attempt would be let through.
 * @returns The error, coded `ErrorCode.TooManyRequests`.
 */
export function rateLimited(message: string, retryAfter: number): GraphQLError {
  return new GraphQLError(message, { extensions: { code: ErrorCode.TooManyRequests, retryAfter } });
}

/**
 * Builds the refusal for an operation that is too deep, too aliased or too costly.
 *
 * @param message - Which limit the operation went over.
 * @returns The error, coded `ErrorCode.QueryTooComplex`, answered as a 400.
 */
export function tooComplex(message: string): GraphQLError {
  return new GraphQLError(message, {
    extensions: { code: ErrorCode.QueryTooComplex, http: { status: HttpStatus.BadRequest } },
  });
}

/**
 * Reads the message of any caught value.
 *
 * @param error - Whatever was thrown.
 * @returns `error.message` for an Error, otherwise `String(error)`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
