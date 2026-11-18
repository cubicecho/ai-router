/**
 * Whether a value is a plain object, such as a parsed JSON object.
 *
 * @param value - Anything.
 * @returns true for a non-null object that isn't an array.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}
