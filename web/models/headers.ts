/** One header per line, as people write them: `Name: value`. */
const HEADER_LINE = /^([^:\s]+)\s*:\s*(.*)$/;

/**
 * Writes headers as text, one `Name: value` per line.
 *
 * @param headers - The headers.
 * @returns The text.
 */
export function headersToText(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

/** What reading headers from text found. */
export type ParsedHeaders = { headers: Record<string, string>; error: null } | { headers: null; error: string };

/**
 * Reads headers from text, one `Name: value` per line, ignoring blank lines.
 *
 * @param text - The text.
 * @returns The headers, or the first line that isn't one.
 */
export function textToHeaders(text: string): ParsedHeaders {
  const headers: Record<string, string> = {};
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const match = HEADER_LINE.exec(trimmed);
    if (match === null) {
      return { headers: null, error: `Line ${index + 1} is not "Name: value".` };
    }
    const [, name = '', value = ''] = match;
    headers[name] = value;
  }
  return { headers, error: null };
}

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
