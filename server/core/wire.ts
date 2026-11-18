/** The HTTP statuses this server sends by hand. */
export const HttpStatus = {
  Ok: 200,
  Found: 302,
  BadRequest: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  PayloadTooLarge: 413,
  TooManyRequests: 429,
  BadGateway: 502,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
} as const;
export type HttpStatus = (typeof HttpStatus)[keyof typeof HttpStatus];

/** Milliseconds in one second. */
export const MS_PER_SECOND = 1000;
/** Seconds in one minute. */
export const SECONDS_PER_MINUTE = 60;
/** Seconds in one day. */
export const SECONDS_PER_DAY = 86_400;
/** Milliseconds in one day. */
export const MS_PER_DAY = 86_400_000;
