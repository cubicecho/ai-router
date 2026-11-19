import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY_RULES } from '../../server/agents/policy.ts';
import { CALLER_WORKSPACE } from '../../server/core/context.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { DEFAULT_POLICY_ID } from '../../server/db/tables/override-policies.ts';
import { Role } from '../../server/db/tables/users.ts';
import { createClient, createUser, type TestClient } from '../helpers.ts';
import { QUESTION, useRunHarness } from './run-harness.ts';

// Override policies: an admin writes them, any user chooses one per agent, and an agent's runs are checked against
// the one it has from its next request.

const h = useRunHarness();

const CREATE =
  'mutation ($values: OverridePolicyInput!) { createOverridePolicy(values: $values) { id name description rules } }';
const UPDATE =
  'mutation ($id: UUID!, $values: OverridePolicyInput!) { updateOverridePolicy(id: $id, values: $values) { id name rules } }';
const DELETE = 'mutation ($id: UUID!) { deleteOverridePolicy(id: $id) { id name } }';
const CHOOSE =
  'mutation ($id: UUID!, $policyId: UUID!) { setAgentOverridePolicy(id: $id, policyId: $policyId) { id overridePolicy { id name } } }';
const POLICIES =
  '{ overridePolicies(orderBy: { name: { direction: asc, priority: 1 } }) { name isDefault agents { name } } }';

/** A policy that lets an app add instructions and nothing else. */
const STRICT = {
  name: 'instructions-only',
  description: 'Instructions, and no sampling settings.',
  rules: { hostPrompt: true, taskPrompt: true, narrowServers: false, sampling: [], responseFormat: false },
};

/**
 * Builds a client for an admin, over the harness's snapshot.
 *
 * @returns The client.
 */
async function asAdmin(): Promise<TestClient> {
  const admin = await createUser(h.db, 'admin@example.com', Role.Admin);
  return createClient(h.db, admin, { snapshot: h.snapshot, tools: h.tools, models: h.models });
}

describe('override policies', () => {
  it('are written by admins only, and read by every user', async () => {
    const admin = await asAdmin();
    const { createOverridePolicy } = await admin.expectOk(CREATE, { values: STRICT });
    expect(createOverridePolicy).toEqual({ id: expect.any(String), ...STRICT });

    const refused = await h.asUser.expectError(CREATE, { values: { ...STRICT, name: 'other' } });
    expect(refused.code).toBe(ErrorCode.Forbidden);
    expect((await h.asUser.expectError(UPDATE, { id: createOverridePolicy.id, values: STRICT })).code).toBe(
      ErrorCode.Forbidden,
    );
    expect((await h.asUser.expectError(DELETE, { id: createOverridePolicy.id })).code).toBe(ErrorCode.Forbidden);
    const asKey = createClient(h.db, { kind: CALLER_WORKSPACE, workspaceId: h.workspaceId, keyId: 'k' });
    expect((await asKey.expectError(CREATE, { values: STRICT })).code).toBe(ErrorCode.Forbidden);

    const { overridePolicies } = await h.asUser.expectOk(POLICIES);
    expect(overridePolicies).toEqual([
      { name: 'default', isDefault: true, agents: [{ name: 'helper' }] },
      { name: 'instructions-only', isDefault: false, agents: [] },
    ]);
  });

  it('refuses a policy that is not one, naming what is wrong', async () => {
    const admin = await asAdmin();
    const refusals: [Record<string, unknown>, string][] = [
      [{ ...STRICT, name: 'Has Spaces' }, 'Name may hold'],
      [{ ...STRICT, name: 'default' }, 'already exists'],
      [{ ...STRICT, rules: { ...STRICT.rules, sampling: ['temperature', 'temperature'] } }, 'once'],
      [{ ...STRICT, rules: { ...STRICT.rules, sampling: ['model'] } }, 'reads that field itself'],
      [{ ...STRICT, rules: { ...STRICT.rules, sampling: ['response_format'] } }, 'reads that field itself'],
      [{ ...STRICT, rules: { ...STRICT.rules, sampling: ['Top P'] } }, 'as OpenAI spells it'],
    ];
    for (const [values, said] of refusals) {
      const refused = await admin.expectError(CREATE, { values });
      expect(refused.code).toBe(ErrorCode.BadUserInput);
      expect(refused.message).toContain(said);
    }
  });

  it('are chosen per agent by any user, and a run is checked against its agent’s from the next request', async () => {
    const admin = await asAdmin();
    const { createOverridePolicy: strict } = await admin.expectOk(CREATE, { values: STRICT });
    const { base } = await h.startRouter();
    const body = { model: 'helper', messages: [QUESTION], temperature: 0.5 };
    expect((await h.complete(base, body)).status).toBe(HttpStatus.Ok);

    const { setAgentOverridePolicy } = await h.asUser.expectOk(CHOOSE, { id: h.agentId, policyId: strict.id });
    expect(setAgentOverridePolicy.overridePolicy).toEqual({ id: strict.id, name: 'instructions-only' });
    const refused = await h.complete(base, body);
    expect(refused.status).toBe(HttpStatus.BadRequest);
    expect(await refused.json()).toMatchObject({ error: { param: 'temperature' } });

    // A change to the policy applies to the agents using it at once.
    const loosened = { ...STRICT, rules: { ...STRICT.rules, sampling: ['temperature'] } };
    await admin.expectOk(UPDATE, { id: strict.id, values: loosened });
    expect((await h.complete(base, body)).status).toBe(HttpStatus.Ok);

    const missing = await h.asUser.expectError(CHOOSE, {
      id: h.agentId,
      policyId: '00000000-0000-4000-8000-0000000000ff',
    });
    expect(missing.code).toBe(ErrorCode.NotFound);
  });

  it('keeps the default and any policy in use, and deletes the rest', async () => {
    const admin = await asAdmin();
    const defaultRefused = await admin.expectError(DELETE, { id: DEFAULT_POLICY_ID });
    expect(defaultRefused.code).toBe(ErrorCode.BadUserInput);
    // The default may be rewritten, though: only deleting it is refused.
    const { updateOverridePolicy } = await admin.expectOk(UPDATE, {
      id: DEFAULT_POLICY_ID,
      values: { name: 'default', rules: DEFAULT_POLICY_RULES },
    });
    expect(updateOverridePolicy.rules).toEqual(DEFAULT_POLICY_RULES);

    const { createOverridePolicy: strict } = await admin.expectOk(CREATE, { values: STRICT });
    await h.asUser.expectOk(CHOOSE, { id: h.agentId, policyId: strict.id });
    const inUse = await admin.expectError(DELETE, { id: strict.id });
    expect(inUse.code).toBe(ErrorCode.Conflict);
    expect(inUse.message).toContain('helper');

    await h.asUser.expectOk(CHOOSE, { id: h.agentId, policyId: DEFAULT_POLICY_ID });
    expect((await admin.expectOk(DELETE, { id: strict.id })).deleteOverridePolicy).toEqual({
      id: strict.id,
      name: 'instructions-only',
    });
    expect((await admin.expectError(DELETE, { id: strict.id })).code).toBe(ErrorCode.NotFound);
  });
});
