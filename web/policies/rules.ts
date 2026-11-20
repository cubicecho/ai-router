import type { OverridePolicyRulesInput } from '@/__generated__/graphql';
// Relative, so the rules read without the app's path alias, as their tests do.
import { isRecord } from '../lib/is-record';

/** What a policy lets an app do, as the page reads its rules. */
export type PolicyRules = OverridePolicyRulesInput;

/** What a policy that says nothing allows: nothing. */
const NOTHING: PolicyRules = {
  narrowServers: false,
  sampling: [],
  responseFormat: false,
};

/**
 * Reads a policy's stored rules.
 *
 * @param rules - The `rules` column, JSON on the wire.
 * @returns The rules, each one missing or of the wrong type read as not allowed.
 */
export function rulesOf(rules: unknown): PolicyRules {
  if (isRecord(rules) === false) {
    return NOTHING;
  }
  const { narrowServers, sampling, responseFormat } = rules;
  return {
    narrowServers: narrowServers === true,
    sampling: Array.isArray(sampling) ? sampling.filter((field) => typeof field === 'string') : [],
    responseFormat: responseFormat === true,
  };
}

/**
 * Says in a line what a policy lets an app do.
 *
 * @param rules - The policy's rules.
 * @returns Such as "An app may send narrower servers, 12 sampling fields and response_format."
 */
export function summaryOf(rules: PolicyRules): string {
  const count = rules.sampling.length;
  const allowed = [
    rules.narrowServers ? 'narrower servers' : undefined,
    count === 0 ? undefined : `${count} sampling ${count === 1 ? 'field' : 'fields'}`,
    rules.responseFormat ? 'response_format' : undefined,
  ].filter((part) => part !== undefined);
  const last = allowed.pop();
  if (last === undefined) {
    return 'An app may change nothing.';
  }
  const listed = allowed.length === 0 ? last : `${allowed.join(', ')} and ${last}`;
  return `An app may send ${listed}.`;
}
