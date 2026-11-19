/**
 * Whether a value is a plain object.
 *
 * @param value - Anything.
 * @returns true for an object that is not an array.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}
