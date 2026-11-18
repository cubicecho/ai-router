import { HttpStatus } from '../core/wire.ts';

/** OpenAI's error `type` for a call the caller got wrong. */
const INVALID_REQUEST = 'invalid_request_error';
/** OpenAI's error `type` for a failure on the serving side. */
const API_ERROR = 'api_error';

/** The failures the router answers itself, before or instead of a provider, in OpenAI's words. */
export const ModelFailure = {
  BadRequest: { status: HttpStatus.BadRequest, type: INVALID_REQUEST, code: 'invalid_request' },
  ModelNotFound: { status: HttpStatus.NotFound, type: INVALID_REQUEST, code: 'model_not_found' },
  NotFound: { status: HttpStatus.NotFound, type: INVALID_REQUEST, code: 'not_found' },
  UpstreamFailed: { status: HttpStatus.BadGateway, type: API_ERROR, code: 'upstream_failed' },
  Unavailable: { status: HttpStatus.ServiceUnavailable, type: API_ERROR, code: 'unavailable' },
  UpstreamTimeout: { status: HttpStatus.GatewayTimeout, type: API_ERROR, code: 'upstream_timeout' },
} as const;
export type ModelFailure = (typeof ModelFailure)[keyof typeof ModelFailure];

/**
 * Builds an answer in OpenAI's error envelope, which an OpenAI client reads as an API error.
 *
 * @param failure - What went wrong.
 * @param message - What the caller is told.
 * @returns The answer.
 */
export function openAiError(failure: ModelFailure, message: string): Response {
  const body = { error: { message, type: failure.type, param: null, code: failure.code } };
  return Response.json(body, { status: failure.status });
}
