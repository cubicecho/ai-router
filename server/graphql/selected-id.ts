import { badInput } from '../core/errors.ts';

/**
 * Reads the id a hand-written field on a generated type needs from its parent row.
 *
 * @param parent - The row as the generated resolver answered it.
 * @param what - The type, as people say it, for the message: "server", "run".
 * @param field - The field asking, for the message.
 * @returns The row's id.
 * @throws BAD_USER_INPUT when the query didn't select it. A generated read returns only the columns a query
 * selected, adding the key only when it selected none, so a field it doesn't know can't count on the id.
 */
export function selectedId(parent: { id?: string }, what: string, field: string): string {
  if (parent.id === undefined) {
    throw badInput(`Select the ${what}'s id alongside ${field}.`);
  }
  return parent.id;
}
