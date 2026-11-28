/**
 * Reads a provider's headers as the API serves them: a JSON object of strings.
 *
 * @param value - The `headers` field.
 * @returns The headers; anything that isn't a string value is left out.
 */
export function headersOf(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}
