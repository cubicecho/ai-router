import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_ROLES } from '../../server/core/admin-roles.ts';
import { CALLER_RUN, type UserCaller } from '../../server/core/context.ts';
import { ROUTER_CONFIG_DEFAULTS, ROUTER_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { MIN_APP_TOOLS } from '../../server/core/settings.ts';
import { createSnapshotHost, loadSnapshot, type SnapshotHost } from '../../server/db/snapshot.ts';
import { settings } from '../../server/db/tables/settings.ts';
import { Role } from '../../server/db/tables/users.ts';
import {
  closeTestDb,
  createClient,
  createTestDb,
  createUser,
  createWorkspaceWithKey,
  resetTestDb,
  type TestDb,
  workspaceCaller,
} from '../helpers.ts';

const READ = '{ routerSettings { maxAppTools { value saved default min max } } }';
const UPDATE =
  'mutation ($input: RouterSettingsInput!) { updateRouterSettings(input: $input) { maxAppTools { value saved } } }';

const { maxAppToolsLimit } = ROUTER_CONFIG_DEFAULTS;

let db: TestDb;
let snapshot: SnapshotHost;
let admin: UserCaller;
let user: UserCaller;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
  admin = await createUser(db, 'admin@example.com', Role.Admin);
  user = await createUser(db, 'bob@example.com');
  snapshot = await createSnapshotHost(db);
});

/**
 * Changes the settings as the admin.
 *
 * @param input - The change.
 * @returns The answer's `maxAppTools`.
 */
async function update(input: Record<string, unknown>) {
  const { updateRouterSettings } = await createClient(db, admin, { snapshot }).expectOk(UPDATE, { input });
  return updateRouterSettings.maxAppTools;
}

describe('the router settings', () => {
  it('follow the defaults until an admin sets one, and every user may read them', async () => {
    const { routerSettings } = await createClient(db, user).expectOk(READ);
    expect(routerSettings.maxAppTools).toEqual({
      value: ROUTER_DEFAULTS.maxAppTools,
      saved: null,
      default: ROUTER_DEFAULTS.maxAppTools,
      min: MIN_APP_TOOLS,
      max: maxAppToolsLimit,
    });
    expect(snapshot.current().settings).toEqual(ROUTER_DEFAULTS);
  });

  it('let an admin change one, which the snapshot holds once the write answers', async () => {
    expect(await update({ maxAppTools: 16 })).toEqual({ value: 16, saved: 16 });
    expect(snapshot.current().settings.maxAppTools).toBe(16);
    expect((await loadSnapshot(db)).settings.maxAppTools).toBe(16);
    const { routerSettings } = await createClient(db, user).expectOk(READ);
    expect(routerSettings.maxAppTools).toMatchObject({ value: 16, saved: 16, default: ROUTER_DEFAULTS.maxAppTools });
  });

  it('keep a setting left out of a change, and return one sent as null to its default', async () => {
    await update({ maxAppTools: 16 });
    expect(await update({})).toEqual({ value: 16, saved: 16 });
    expect(await update({ maxAppTools: null })).toEqual({ value: ROUTER_DEFAULTS.maxAppTools, saved: null });
    expect(snapshot.current().settings).toEqual(ROUTER_DEFAULTS);
  });

  it('leave pruning app tools across servers off until an admin turns it on, and back to the default', async () => {
    const PRUNING = 'pruneAppToolsAcrossServers { value saved default }';
    const client = createClient(db, admin, { snapshot });
    const read = async () => (await client.expectOk(`{ routerSettings { ${PRUNING} } }`)).routerSettings;
    const change = async (value: boolean | null) =>
      (
        await client.expectOk(
          `mutation ($input: RouterSettingsInput!) { updateRouterSettings(input: $input) { ${PRUNING} } }`,
          { input: { pruneAppToolsAcrossServers: value } },
        )
      ).updateRouterSettings;
    expect((await read()).pruneAppToolsAcrossServers).toEqual({ value: false, saved: null, default: false });
    expect(ROUTER_DEFAULTS.pruneAppToolsAcrossServers).toBe(false);
    expect((await change(true)).pruneAppToolsAcrossServers).toEqual({ value: true, saved: true, default: false });
    expect(snapshot.current().settings.pruneAppToolsAcrossServers).toBe(true);
    // Changing the cap keeps it.
    await update({ maxAppTools: 8 });
    expect((await read()).pruneAppToolsAcrossServers.value).toBe(true);
    expect((await change(null)).pruneAppToolsAcrossServers).toEqual({ value: false, saved: null, default: false });
    expect(snapshot.current().settings).toEqual({ ...ROUTER_DEFAULTS, maxAppTools: 8 });
    const asUser = await createClient(db, user, { snapshot }).expectError(UPDATE, {
      input: { pruneAppToolsAcrossServers: true },
    });
    expect(asUser.code).toBe(ErrorCode.Forbidden);
  });

  it('refuse a user who is not an admin, a workspace key and an agent run', async () => {
    const asUser = await createClient(db, user, { snapshot }).expectError(UPDATE, { input: { maxAppTools: 4 } });
    expect(asUser.code).toBe(ErrorCode.Forbidden);
    const { workspaceId, keyId } = await createWorkspaceWithKey(db, 'task-server');
    const asKey = createClient(db, workspaceCaller(workspaceId, keyId), { snapshot });
    expect((await asKey.expectError(UPDATE, { input: { maxAppTools: 4 } })).code).toBe(ErrorCode.Forbidden);
    expect((await asKey.expectError(READ)).code).toBe(ErrorCode.Forbidden);
    const run = { kind: CALLER_RUN, runId: 'run-1', workspaceId, agentId: 'agent-1', roles: ADMIN_ROLES };
    const asRun = createClient(db, run, { snapshot });
    expect((await asRun.expectError(UPDATE, { input: { maxAppTools: 4 } })).code).toBe(ErrorCode.Forbidden);
    expect((await asRun.expectError(READ)).code).toBe(ErrorCode.Forbidden);
    expect(await db.select().from(settings)).toEqual([]);
    expect(snapshot.current().settings).toEqual(ROUTER_DEFAULTS);
  });

  it('refuse a cap that is not a whole number from the minimum to the limit', async () => {
    const client = createClient(db, admin, { snapshot });
    for (const maxAppTools of [MIN_APP_TOOLS - 1, maxAppToolsLimit + 1]) {
      expect((await client.expectError(UPDATE, { input: { maxAppTools } })).code).toBe(ErrorCode.BadUserInput);
    }
    // GraphQL's Int refuses a fraction before the resolver sees it.
    await client.expectError(UPDATE, { input: { maxAppTools: 2.5 } });
    expect(await update({ maxAppTools: maxAppToolsLimit })).toEqual({
      value: maxAppToolsLimit,
      saved: maxAppToolsLimit,
    });
    expect(await update({ maxAppTools: MIN_APP_TOOLS })).toEqual({ value: MIN_APP_TOOLS, saved: MIN_APP_TOOLS });
  });

  it('route by the defaults when the saved row no longer passes the rules', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await db.insert(settings).values({ values: { maxAppTools: maxAppToolsLimit + 1 } });
    expect((await loadSnapshot(db)).settings).toEqual(ROUTER_DEFAULTS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[settings]'));
    warn.mockRestore();
  });
});
