import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { activity } from '../../server/db/tables/activity.ts';
import { servers } from '../../server/db/tables/servers.ts';
import { createActivityRecorder } from '../../server/tools/activity.ts';
import { closeTestDb, createTestDb, resetTestDb, type TestDb } from '../helpers.ts';

const CALL = { serverId: null, serverName: 'git', workspaceId: null, workspaceName: null, tool: 'log', durationMs: 12 };

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(() => resetTestDb(db));

describe('the activity recorder', () => {
  it('writes calls only when it flushes, with a failure cut short', async () => {
    const recorder = createActivityRecorder(db, { maxErrorLength: 5 });
    recorder.record({ ...CALL, ok: true });
    recorder.record({ ...CALL, ok: false, error: 'a very long reason' });
    expect(await db.select().from(activity)).toEqual([]);
    await recorder.flush();
    const rows = await db.select().from(activity);
    expect(rows.map((row) => [row.ok, row.error])).toEqual([
      [true, null],
      [false, 'a ver'],
    ]);
  });

  it('deletes calls past the retention', async () => {
    const day = 86_400_000;
    let clock = new Date('2026-11-01T00:00:00Z');
    const recorder = createActivityRecorder(db, { retentionDays: 2 }, () => clock);
    recorder.record({ ...CALL, tool: 'old', ok: true });
    clock = new Date(clock.getTime() + 3 * day);
    recorder.record({ ...CALL, tool: 'new', ok: true });
    await recorder.flush();
    await recorder.prune();
    expect((await db.select().from(activity)).map((row) => row.tool)).toEqual(['new']);
  });

  it('keeps at most maxPending calls in memory', async () => {
    const recorder = createActivityRecorder(db, { maxPending: 2 });
    for (const tool of ['a', 'b', 'c']) {
      recorder.record({ ...CALL, tool, ok: true });
    }
    await recorder.stop();
    expect((await db.select().from(activity)).map((row) => row.tool).sort()).toEqual(['b', 'c']);
  });
});

describe('a call recorded just before its server is deleted', () => {
  it('is written with the server named and its id cleared, not retried forever', async () => {
    const [server] = await db
      .insert(servers)
      .values({ name: 'gone', source: { type: 'manual' }, transport: { type: 'stdio', command: 'node', args: [] } })
      .returning();
    const recorder = createActivityRecorder(db);
    recorder.record({ ...CALL, serverId: server?.id ?? null, serverName: 'gone', ok: true });
    await db.delete(servers);
    await recorder.flush();
    expect((await db.select().from(activity)).map((row) => [row.serverName, row.serverId])).toEqual([['gone', null]]);
  });
});
