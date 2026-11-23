import type { ElicitRequest, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { isRecord } from '../core/is-record.ts';

/** The answer to a question that can't be put, or that nobody answered in time. */
export const DECLINED: ElicitResult = { action: 'decline' };

/**
 * Reads an app's answer to a question, from the tool message that carries it.
 *
 * @param content - The message's text: an `ElicitResult` as JSON.
 * @returns The answer, or a decline for anything else.
 */
export function answerOf(content: string): ElicitResult {
  try {
    const parsed = ElicitResultSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : DECLINED;
  } catch {
    return DECLINED;
  }
}

/**
 * Names the form fields an answer filled in, which is all a run's events say of it: a value can be a password.
 *
 * @param params - The question, for the fields its form declares.
 * @param answer - The answer.
 * @returns The declared fields it holds a value for.
 */
export function answeredFields(params: ElicitRequest['params'], answer: ElicitResult): string[] {
  const schema = 'requestedSchema' in params ? params.requestedSchema : undefined;
  const properties = isRecord(schema) ? schema.properties : undefined;
  if (answer.content === undefined || isRecord(properties) === false) {
    return [];
  }
  return Object.keys(answer.content).filter((key) => Object.hasOwn(properties, key));
}
