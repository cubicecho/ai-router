import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { providers, usageCounts, workspaces } from '../../server/db/schema.ts';
import { createUsageRecorder, type ServedBy, utcDay } from '../../server/models/usage.ts';
import { closeTestDb, createTestDb, resetTestDb, type TestDb } from '../helpers.ts';

const NOW = new Date('2026-11-18T23:30:00Z');

let db: TestDb;
let served: ServedBy;

/**
 * Reads every usage row, without ids.
 *
 * @returns The rows, ordered by day with the all-time row last.
 */
async function rows() {
  const all = await db.select().from(usageCounts);
  return all
    .map(({ id: _id, ...row }) => row)
    .sort(
      (a, b) =>
        (a.day ?? '9999').localeCompare(b.day ?? '9999') ||
        (a.workspaceName ?? '').localeCompare(b.workspaceName ?? ''),
    );
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
  const [workspace] = await db.insert(workspaces).values({ slug: 'min-agent', name: 'min-agent' }).returning();
  const [provider] = await db.insert(providers).values({ name: 'ollama', baseUrl: 'http://ollama/v1' }).returning();
  if (workspace === undefined || provider === undefined) {
    throw new Error('Seeding failed.');
  }
  served = {
    workspaceId: workspace.id,
    workspaceName: workspace.slug,
    agentId: null,
    agentName: null,
    providerId: provider.id,
    providerName: provider.name,
    model: 'qwen3:8b',
  };
});

describe('the usage recorder', () => {
  it('counts calls in memory and writes them once, on the UTC day', async () => {
    const recorder = createUsageRecorder(db, {}, () => NOW);
    recorder.record(served, { inputTokens: 3, outputTokens: 4 });
    recorder.record(served);
    expect(await rows()).toEqual([]);
    await recorder.flush();
    expect(await rows()).toEqual([{ ...served, day: '2026-11-18', requests: 2, inputTokens: 3, outputTokens: 4 }]);
  });

  it('adds to a row already written', async () => {
    const recorder = createUsageRecorder(db, {}, () => NOW);
    recorder.record(served, { inputTokens: 1, outputTokens: 1 });
    await recorder.flush();
    recorder.record(served, { inputTokens: 1, outputTokens: 1 });
    await recorder.flush();
    expect((await rows())[0]).toMatchObject({ requests: 2, inputTokens: 2, outputTokens: 2 });
  });

  it('keeps calls with no workspace on one row of their own', async () => {
    const recorder = createUsageRecorder(db, {}, () => NOW);
    const unattributed = { ...served, workspaceId: null, workspaceName: null };
    recorder.record(unattributed);
    await recorder.flush();
    recorder.record(unattributed);
    await recorder.flush();
    expect(await rows()).toEqual([{ ...unattributed, day: utcDay(NOW), requests: 2, inputTokens: 0, outputTokens: 0 }]);
  });

  it('keeps usage after its provider and workspace are deleted, by name', async () => {
    const recorder = createUsageRecorder(db, {}, () => NOW);
    recorder.record(served);
    await recorder.flush();
    await db.delete(providers).where(eq(providers.name, 'ollama'));
    await db.delete(workspaces).where(eq(workspaces.slug, 'min-agent'));
    expect((await rows())[0]).toMatchObject({
      providerId: null,
      providerName: 'ollama',
      workspaceId: null,
      workspaceName: 'min-agent',
      requests: 1,
    });
  });

  it('writes a call whose provider and workspace were deleted before the write, by name', async () => {
    const recorder = createUsageRecorder(db, {}, () => NOW);
    recorder.record(served);
    await db.delete(providers).where(eq(providers.name, 'ollama'));
    await db.delete(workspaces).where(eq(workspaces.slug, 'min-agent'));
    await recorder.flush();
    expect(await rows()).toMatchObject([{ providerId: null, providerName: 'ollama', workspaceId: null, requests: 1 }]);
  });

  it('folds days past the detail window into the all-time row, and keeps the rest', async () => {
    const old = { ...served, requests: 1, inputTokens: 10, outputTokens: 1 };
    await db.insert(usageCounts).values([
      { ...old, day: '2026-01-01' },
      { ...old, day: '2026-02-01' },
      { ...old, day: null, requests: 5 },
      { ...old, day: '2026-11-17' },
    ]);
    await createUsageRecorder(db, { detailDays: 90 }, () => NOW).fold();
    expect(await rows()).toEqual([
      { ...old, day: '2026-11-17' },
      { ...old, day: null, requests: 7, inputTokens: 30, outputTokens: 3 },
    ]);
  });

  it('writes what is left when it stops', async () => {
    const recorder = createUsageRecorder(db, {}, () => NOW);
    recorder.record(served);
    await recorder.stop();
    expect(await rows()).toHaveLength(1);
  });
});
