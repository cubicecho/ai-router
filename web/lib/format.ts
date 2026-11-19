/**
 * Formats a timestamp as a date, without its time.
 *
 * @param iso - An ISO timestamp.
 * @returns The date in the reader's locale.
 */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString();
}

/**
 * Says how many of something there are, with the noun that fits the number.
 *
 * @param count - How many.
 * @param one - The noun for one: "key".
 * @param many - The noun for any other number: "keys".
 * @returns Such as "1 key", "0 keys" or "3 keys".
 */
export function countOf(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}
