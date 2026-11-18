/** The HTTP statuses this server sends by hand. */
export const HttpStatus = {
  Ok: 200,
  Found: 302,
  BadRequest: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  Conflict: 409,
  PayloadTooLarge: 413,
  UnprocessableEntity: 422,
  TooManyRequests: 429,
  InternalServerError: 500,
  BadGateway: 502,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
} as const;
export type HttpStatus = (typeof HttpStatus)[keyof typeof HttpStatus];

/** Milliseconds in one second. */
export const MS_PER_SECOND = 1000;
/** Milliseconds in one minute. */
export const MS_PER_MINUTE = 60_000;
/** Milliseconds in one hour. */
export const MS_PER_HOUR = 3_600_000;
/** Seconds in one minute. */
export const SECONDS_PER_MINUTE = 60;
/** Seconds in one day. */
export const SECONDS_PER_DAY = 86_400;
/** Milliseconds in one day. */
export const MS_PER_DAY = 86_400_000;
