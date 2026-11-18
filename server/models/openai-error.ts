import { HttpStatus } from '../core/wire.ts';

/** OpenAI's error `type` for a call the caller got wrong. */
const INVALID_REQUEST = 'invalid_request_error';
/** OpenAI's error `type` for a failure on the serving side. */
const API_ERROR = 'api_error';

/**
 * The failures the router answers itself in OpenAI's words: before or instead of a provider, and on the agents
 * endpoint.
 */
export const ModelFailure = {
  BadRequest: { status: HttpStatus.BadRequest, type: INVALID_REQUEST, code: 'invalid_request' },
  Unauthenticated: { status: HttpStatus.Unauthorized, type: INVALID_REQUEST, code: 'invalid_api_key' },
  PayloadTooLarge: { status: HttpStatus.PayloadTooLarge, type: INVALID_REQUEST, code: 'request_too_large' },
  IdempotencyMismatch: {
    status: HttpStatus.UnprocessableEntity,
    type: INVALID_REQUEST,
    code: 'idempotency_key_reused',
  },
  RunCancelled: { status: HttpStatus.Conflict, type: INVALID_REQUEST, code: 'run_cancelled' },
  RunInProgress: { status: HttpStatus.Conflict, type: INVALID_REQUEST, code: 'run_in_progress' },
  RunExpired: { status: HttpStatus.Conflict, type: INVALID_REQUEST, code: 'run_expired' },
  ConversationBusy: { status: HttpStatus.Conflict, type: INVALID_REQUEST, code: 'conversation_busy' },
  RunFailed: { status: HttpStatus.InternalServerError, type: API_ERROR, code: 'run_failed' },
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
  return Response.json(openAiErrorBody(failure, message), { status: failure.status });
}

/** OpenAI's error envelope. */
export interface OpenAiErrorBody {
  error: { message: string; type: string; param: string | null; code: string };
}

/**
 * Builds OpenAI's error envelope, for a door that writes its own answer.
 *
 * @param failure - What went wrong. Its status is the caller's to send.
 * @param message - What the caller is told.
 * @param [param] - The request field it is about.
 * @returns The body.
 */
export function openAiErrorBody(failure: ModelFailure, message: string, param: string | null = null): OpenAiErrorBody {
  return { error: { message, type: failure.type, param, code: failure.code } };
}
