import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserCaller } from '../../server/core/context.ts';
import { MODEL_CONFIG_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { usageCounts } from '../../server/db/schema.ts';
import { createSnapshotHost } from '../../server/db/snapshot.ts';
import { Role } from '../../server/db/tables/users.ts';
import type { UpstreamFetch } from '../../server/models/outbound.ts';
import { createModelServices } from '../../server/models/services.ts';
import {
  closeTestDb,
  createClient,
  createTestDb,
  createUser,
  createWorkspaceWithKey,
  resetTestDb,
  type TestClient,
  type TestDb,
  workspaceCaller,
} from '../helpers.ts';

const SECRET = 'sk-planted-provider-secret';

const CREATE_PROVIDER = `mutation ($values: CreateProviderInput!) {
  createProvider(values: $values) { id name baseUrl headers apiKeySet }
}`;
const SET_KEY =
  'mutation ($id: UUID!, $apiKey: String) { setProviderApiKey(id: $id, apiKey: $apiKey) { id apiKeySet } }';
const CREATE_POOL = `mutation ($values: CreatePoolInput!) {
  createPool(values: $values) { id name strategy affinity maxLoadFactor }
}`;
const SET_TARGETS = `mutation ($poolId: UUID!, $targets: [PoolTargetInput!]!) {
  setPoolTargets(poolId: $poolId, targets: $targets) { id targets(orderBy: { position: { direction: asc, priority: 1 } }) { model position weight provider { name } } }
}`;
const POOL_LOAD =
  'query ($id: UUID!) { poolLoad(id: $id) { providerName model weight inFlight reachable checkedAt downReason } }';
const EVERYTHING = `{
  providers { id name displayName description enabled baseUrl headers apiKeySet createdAt updatedAt targets { model } usage { requests } }
  pools { id name targets { model provider { name baseUrl headers apiKeySet } } }
}`;

let db: TestDb;
let admin: UserCaller;
let user: UserCaller;
let asAdmin: TestClient;
let asUser: TestClient;

/**
 * Makes a provider through the API.
 *
 * @param name - Its name.
 * @returns Its id.
 */
async function makeProvider(name: string): Promise<string> {
  const { createProvider } = await asUser.expectOk(CREATE_PROVIDER, {
    values: { name, baseUrl: `http://${name}:11434/v1` },
  });
  return createProvider.id;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
  admin = await createUser(db, 'admin@example.com', Role.Admin);
  user = await createUser(db, 'user@example.com');
  asAdmin = createClient(db, admin);
  asUser = createClient(db, user);
});

describe('providers', () => {
  it('lets any user add one, with headers and no key', async () => {
    const { createProvider } = await asUser.expectOk(CREATE_PROVIDER, {
      values: { name: 'llama.cpp', baseUrl: 'http://gpu:8080/v1', headers: { 'X-Team': 'home' } },
    });
    expect(createProvider).toMatchObject({ name: 'llama.cpp', headers: { 'X-Team': 'home' }, apiKeySet: false });
  });

  it.each([
    ['a bad name', { name: 'Ollama', baseUrl: 'http://o/v1' }],
    ['a base URL that is not http', { name: 'o', baseUrl: 'ftp://o/v1' }],
    ['a base URL that is not a URL', { name: 'o', baseUrl: 'ollama' }],
    ['a header name with a space', { name: 'o', baseUrl: 'http://o/v1', headers: { 'x y': '1' } }],
    ['a header value with a line break', { name: 'o', baseUrl: 'http://o/v1', headers: { x: 'a\r\nb: c' } }],
  ])('refuses %s', async (_label, values) => {
    expect((await asUser.expectError(CREATE_PROVIDER, { values })).code).toBe(ErrorCode.BadUserInput);
  });

  it('says a name is taken', async () => {
    await makeProvider('ollama');
    const { code, message } = await asUser.expectError(CREATE_PROVIDER, {
      values: { name: 'ollama', baseUrl: 'http://x/v1' },
    });
    expect(code).toBe(ErrorCode.BadUserInput);
    expect(message).toContain('already exists');
  });

  it('rebuilds the snapshot once a write commits', async () => {
    const snapshot = await createSnapshotHost(db);
    const client = createClient(db, user, { snapshot });
    await client.expectOk(CREATE_PROVIDER, { values: { name: 'ollama', baseUrl: 'http://o/v1' } });
    expect(snapshot.current().providers.get('ollama')?.baseUrl).toBe('http://o/v1');
  });
});

describe('a provider key', () => {
  it('is set by an admin, read only as set or not, and cleared by null', async () => {
    const id = await makeProvider('openai');
    expect((await asAdmin.expectOk(SET_KEY, { id, apiKey: SECRET })).setProviderApiKey.apiKeySet).toBe(true);
    expect((await asAdmin.expectOk(SET_KEY, { id, apiKey: null })).setProviderApiKey.apiKeySet).toBe(false);
  });

  it('is refused to a user who is not an admin', async () => {
    const id = await makeProvider('openai');
    expect((await asUser.expectError(SET_KEY, { id, apiKey: SECRET })).code).toBe(ErrorCode.Forbidden);
  });

  it('never appears in any answer, and has no field to read it by', async () => {
    const id = await makeProvider('openai');
    await asAdmin.expectOk(SET_KEY, { id, apiKey: SECRET });
    const { createPool } = await asUser.expectOk(CREATE_POOL, { values: { name: 'gpt' } });
    await asUser.expectOk(SET_TARGETS, { poolId: createPool.id, targets: [{ providerId: id, model: 'gpt-5' }] });
    const answers = JSON.stringify([await asAdmin.expectOk(EVERYTHING), await asUser.expectOk(EVERYTHING)]);
    expect(answers).not.toContain(SECRET);
    expect((await asAdmin.expectError('{ providers { apiKey } }')).message).toContain('Cannot query field "apiKey"');
  });
});

describe('pools', () => {
  it('are made with a strategy and an affinity, least-busy and sticky unless said', async () => {
    const { createPool } = await asUser.expectOk(CREATE_POOL, { values: { name: 'qwen3' } });
    expect(createPool).toMatchObject({ strategy: 'least_busy', affinity: 'sticky', maxLoadFactor: null });
    const { createPool: other } = await asUser.expectOk(CREATE_POOL, {
      values: { name: 'rr', strategy: 'round_robin', affinity: 'none', maxLoadFactor: 1.25 },
    });
    expect(other).toMatchObject({ strategy: 'round_robin', affinity: 'none', maxLoadFactor: 1.25 });
  });

  it('refuses a load factor under 1', async () => {
    const { code } = await asUser.expectError(CREATE_POOL, { values: { name: 'q', maxLoadFactor: 0.5 } });
    expect(code).toBe(ErrorCode.BadUserInput);
  });

  it('takes its targets whole and in order, and replaces them the same way', async () => {
    const ollama = await makeProvider('ollama');
    const gpu = await makeProvider('gpu');
    const { createPool } = await asUser.expectOk(CREATE_POOL, { values: { name: 'qwen3' } });
    const first = await asUser.expectOk(SET_TARGETS, {
      poolId: createPool.id,
      targets: [
        { providerId: gpu, model: 'qwen3:32b' },
        { providerId: ollama, model: 'qwen3:8b' },
      ],
    });
    expect(first.setPoolTargets.targets).toEqual([
      { model: 'qwen3:32b', position: 0, weight: 1, provider: { name: 'gpu' } },
      { model: 'qwen3:8b', position: 1, weight: 1, provider: { name: 'ollama' } },
    ]);
    const second = await asUser.expectOk(SET_TARGETS, {
      poolId: createPool.id,
      targets: [{ providerId: ollama, model: 'qwen3:8b' }],
    });
    expect(second.setPoolTargets.targets).toEqual([
      { model: 'qwen3:8b', position: 0, weight: 1, provider: { name: 'ollama' } },
    ]);
  });

  it("keeps each target's weight", async () => {
    const id = await makeProvider('ollama');
    const { createPool } = await asUser.expectOk(CREATE_POOL, { values: { name: 'qwen3' } });
    const { setPoolTargets } = await asUser.expectOk(SET_TARGETS, {
      poolId: createPool.id,
      targets: [
        { providerId: id, model: 'big', weight: MODEL_CONFIG_DEFAULTS.maxTargetWeight },
        { providerId: id, model: 'small' },
      ],
    });
    expect(setPoolTargets.targets.map((target: { weight: number }) => target.weight)).toEqual([
      MODEL_CONFIG_DEFAULTS.maxTargetWeight,
      1,
    ]);
  });

  it.each([
    [
      'the same target twice',
      (id: string) => [
        { providerId: id, model: 'm' },
        { providerId: id, model: 'm' },
      ],
    ],
    ['a provider that does not exist', () => [{ providerId: '00000000-0000-4000-8000-000000000000', model: 'm' }]],
    ['a target with no model', (id: string) => [{ providerId: id, model: ' ' }]],
    ['a weight under 1', (id: string) => [{ providerId: id, model: 'm', weight: 0 }]],
    [
      'a weight over the most a target may have',
      (id: string) => [{ providerId: id, model: 'm', weight: MODEL_CONFIG_DEFAULTS.maxTargetWeight + 1 }],
    ],
  ])('refuses %s', async (_label, targets) => {
    const id = await makeProvider('ollama');
    const { createPool } = await asUser.expectOk(CREATE_POOL, { values: { name: 'q' } });
    const { code } = await asUser.expectError(SET_TARGETS, { poolId: createPool.id, targets: targets(id) });
    expect(code).toBe(ErrorCode.BadUserInput);
  });

  it('loses a target when its provider is deleted', async () => {
    const id = await makeProvider('ollama');
    const { createPool } = await asUser.expectOk(CREATE_POOL, { values: { name: 'q' } });
    await asUser.expectOk(SET_TARGETS, { poolId: createPool.id, targets: [{ providerId: id, model: 'm' }] });
    await asUser.expectOk('mutation ($id: UUID!) { deleteProvider(where: { id: { eq: $id } }) { id } }', { id });
    const { pools } = await asUser.expectOk('{ pools { targets { model } } }');
    expect(pools).toEqual([{ targets: [] }]);
  });

  it("reports each target's load, weight and health", async () => {
    const id = await makeProvider('ollama');
    const { createPool } = await asUser.expectOk(CREATE_POOL, { values: { name: 'q' } });
    await asUser.expectOk(SET_TARGETS, { poolId: createPool.id, targets: [{ providerId: id, model: 'm', weight: 3 }] });
    const { poolLoad } = await asUser.expectOk(POOL_LOAD, { id: createPool.id });
    expect(poolLoad).toEqual([
      {
        providerName: 'ollama',
        model: 'm',
        weight: 3,
        inFlight: 0,
        reachable: true,
        checkedAt: null,
        downReason: null,
      },
    ]);
  });

  it('says when a health check last looked at a target, and why it is down', async () => {
    const fetch: UpstreamFetch = async () => {
      const text = JSON.stringify({ data: [{ id: 'other' }] });
      return { status: 200, ok: true, headers: new Headers(), body: null, text: async () => text };
    };
    const snapshot = await createSnapshotHost(db);
    const models = createModelServices({ db, snapshot, fetch });
    const client = createClient(db, user, { snapshot, models });
    const { createProvider } = await client.expectOk(CREATE_PROVIDER, {
      values: { name: 'ollama', baseUrl: 'http://o/v1' },
    });
    const { createPool } = await client.expectOk(CREATE_POOL, { values: { name: 'q' } });
    await client.expectOk(SET_TARGETS, {
      poolId: createPool.id,
      targets: [{ providerId: createProvider.id, model: 'm' }],
    });
    await models.health.check();
    const { poolLoad } = await client.expectOk(POOL_LOAD, { id: createPool.id });
    expect(poolLoad).toEqual([
      expect.objectContaining({
        reachable: false,
        checkedAt: expect.any(Date),
        downReason: 'ollama does not list m.',
      }),
    ]);
  });
});

describe('model prices', () => {
  const SET_PRICE = `mutation ($providerId: UUID!, $model: String!, $price: ModelPriceInput) {
    setModelPrice(providerId: $providerId, model: $model, price: $price) { model inputPerMillion outputPerMillion }
  }`;
  const PRICES = '{ modelPrices { model inputPerMillion outputPerMillion provider { name } } }';

  it('are set by any user, replaced by a second set, and cleared by null', async () => {
    const providerId = await makeProvider('openai');
    const price = { inputPerMillion: 1.25, outputPerMillion: 10 };
    const { setModelPrice } = await asUser.expectOk(SET_PRICE, { providerId, model: ' gpt-5 ', price });
    expect(setModelPrice).toEqual({ model: 'gpt-5', ...price });
    const cheaper = { inputPerMillion: 0.5, outputPerMillion: 4 };
    await asUser.expectOk(SET_PRICE, { providerId, model: 'gpt-5', price: cheaper });
    expect((await asUser.expectOk(PRICES)).modelPrices).toEqual([
      { model: 'gpt-5', ...cheaper, provider: { name: 'openai' } },
    ]);
    expect((await asUser.expectOk(SET_PRICE, { providerId, model: 'gpt-5', price: null })).setModelPrice).toBeNull();
    expect((await asUser.expectOk(PRICES)).modelPrices).toEqual([]);
  });

  it.each([
    ['a price below 0', { inputPerMillion: -1, outputPerMillion: 1 }],
    ['a price past the most', { inputPerMillion: 1, outputPerMillion: MODEL_CONFIG_DEFAULTS.maxPricePerMillion + 1 }],
  ])('refuses %s', async (_label, price) => {
    const providerId = await makeProvider('openai');
    const { code } = await asUser.expectError(SET_PRICE, { providerId, model: 'gpt-5', price });
    expect(code).toBe(ErrorCode.BadUserInput);
  });

  it('answers NOT_FOUND for a provider that does not exist', async () => {
    const { code } = await asUser.expectError(SET_PRICE, {
      providerId: '00000000-0000-4000-8000-000000000000',
      model: 'gpt-5',
      price: { inputPerMillion: 1, outputPerMillion: 1 },
    });
    expect(code).toBe(ErrorCode.NotFound);
  });

  it("go with their provider when it's deleted", async () => {
    const providerId = await makeProvider('openai');
    await asUser.expectOk(SET_PRICE, {
      providerId,
      model: 'gpt-5',
      price: { inputPerMillion: 1, outputPerMillion: 1 },
    });
    await asUser.expectOk('mutation ($id: UUID!) { deleteProvider(where: { id: { eq: $id } }) { id } }', {
      id: providerId,
    });
    expect((await asUser.expectOk(PRICES)).modelPrices).toEqual([]);
  });

  it('are set on a pool with both prices or neither', async () => {
    const { createPool } = await asUser.expectOk(
      'mutation ($values: CreatePoolInput!) { createPool(values: $values) { inputPricePerMillion outputPricePerMillion } }',
      { values: { name: 'priced', inputPricePerMillion: 0.2, outputPricePerMillion: 0.6 } },
    );
    expect(createPool).toEqual({ inputPricePerMillion: 0.2, outputPricePerMillion: 0.6 });
    const { code, message } = await asUser.expectError(CREATE_POOL, {
      values: { name: 'half', inputPricePerMillion: 0.2 },
    });
    expect(code).toBe(ErrorCode.BadUserInput);
    expect(message).toContain('both prices');
    const negative = await asUser.expectError(CREATE_POOL, {
      values: { name: 'neg', inputPricePerMillion: -1, outputPricePerMillion: 1 },
    });
    expect(negative.code).toBe(ErrorCode.BadUserInput);
  });
});

describe("a pool's usage", () => {
  it('is read by the pool, apart from calls naming its targets directly', async () => {
    const providerId = await makeProvider('ollama');
    const { createPool } = await asUser.expectOk(CREATE_POOL, { values: { name: 'qwen3' } });
    const row = { day: '2026-11-18', providerId, providerName: 'ollama', model: 'qwen3:8b', requests: 1 };
    await db.insert(usageCounts).values([
      { ...row, poolId: createPool.id, poolName: 'qwen3', requests: 3 },
      { ...row, poolId: null, poolName: null },
    ]);
    const { usageCounts: byPool } = await asUser.expectOk(
      'query ($poolId: UUID!) { usageCounts(where: { poolId: { eq: $poolId } }) { poolName providerName requests } }',
      { poolId: createPool.id },
    );
    expect(byPool).toEqual([{ poolName: 'qwen3', providerName: 'ollama', requests: 3 }]);
  });
});

describe('providerModels', () => {
  const MODELS = 'query ($id: UUID!, $refresh: Boolean) { providerModels(id: $id, refresh: $refresh) { id ownedBy } }';

  it('lists what the provider serves, and says why when it cannot', async () => {
    let isUp = true;
    const fetch: UpstreamFetch = async () => {
      if (isUp === false) {
        throw new Error('connection refused');
      }
      const text = JSON.stringify({ data: [{ id: 'qwen3:8b', owned_by: 'library' }] });
      return { status: 200, ok: true, headers: new Headers(), body: null, text: async () => text };
    };
    const snapshot = await createSnapshotHost(db);
    const client = createClient(db, user, { snapshot, models: createModelServices({ db, snapshot, fetch }) });
    const { createProvider } = await client.expectOk(CREATE_PROVIDER, {
      values: { name: 'ollama', baseUrl: 'http://o/v1' },
    });
    expect((await client.expectOk(MODELS, { id: createProvider.id })).providerModels).toEqual([
      { id: 'qwen3:8b', ownedBy: 'library' },
    ]);
    isUp = false;
    const { code, message } = await client.expectError(MODELS, { id: createProvider.id, refresh: true });
    expect(code).toBe(ErrorCode.UpstreamFailed);
    expect(message).toContain('connection refused');
  });
});

describe('a workspace key', () => {
  it('reaches none of it', async () => {
    const { workspaceId, keyId } = await createWorkspaceWithKey(db, 'min-agent');
    const app = createClient(db, workspaceCaller(workspaceId, keyId));
    expect((await app.expectError('{ providers { id } }')).code).toBe(ErrorCode.Forbidden);
    const { code } = await app.expectError(CREATE_PROVIDER, { values: { name: 'x', baseUrl: 'http://x/v1' } });
    expect(code).toBe(ErrorCode.Forbidden);
  });
});
