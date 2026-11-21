import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type UpgradeLog, upgradeStored } from '../../server/agents/upgrade.ts';
import { agentRevisions } from '../../server/db/tables/agent-revisions.ts';
import { agents } from '../../server/db/tables/agents.ts';
import { type RunResume, RunStatus, runs } from '../../server/db/tables/runs.ts';
import { closeTestDb, createTestDb, resetTestDb, type TestDb } from '../helpers.ts';

// The boot upgrade to agent-core 7: version 1 documents become version 2, and a waiting run keeps its layers under
// the new names. Running it again changes nothing.

let db: TestDb;

/**
 * Builds a log that keeps what it is told.
 *
 * @returns The log, with its warnings and its other lines.
 */
function recordingLog(): UpgradeLog & { warnings: string[]; lines: string[] } {
  const warnings: string[] = [];
  const lines: string[] = [];
  return { warnings, lines, warn: (message) => warnings.push(message), log: (message) => lines.push(message) };
}

/**
 * Adds an agent with one revision.
 *
 * @param name - Its name.
 * @param document - Its revision's document.
 * @returns The agent's and the revision's ids.
 */
async function addAgent(name: string, document: Record<string, unknown>) {
  const [agent] = await db.insert(agents).values({ name }).returning();
  if (agent === undefined) {
    throw new Error('No agent was added.');
  }
  const [revision] = await db.insert(agentRevisions).values({ agentId: agent.id, number: 1, document }).returning();
  if (revision === undefined) {
    throw new Error('No revision was added.');
  }
  return { agentId: agent.id, revisionId: revision.id };
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(() => closeTestDb(db));

beforeEach(async () => {
  await resetTestDb(db);
});

describe('the upgrade to agent-core 7', () => {
  it('turns version 1 documents into version 2, dropping a part that only had a reference, with a warning', async () => {
    const old = {
      spec: 'cubicecho.agent/1',
      id: 'helper',
      model: { model: 'fake/m1' },
      prompt: [
        { id: 'identity', text: 'You help.' },
        { id: 'rules', ref: { type: 'file', value: './rules.md' } },
      ],
    };
    const { revisionId } = await addAgent('helper', old);
    const log = recordingLog();
    await upgradeStored(db, log);
    const [revision] = await db.select().from(agentRevisions).where(eq(agentRevisions.id, revisionId));
    expect(revision?.document).toEqual({
      spec: 'cubicecho.agent/2',
      id: 'helper',
      model: { model: 'fake/m1' },
      prompt: [{ role: 'system', name: 'identity', content: 'You help.' }],
    });
    expect(revision?.warnings).toEqual([expect.stringContaining('prompt[1]')]);
    expect(log.warnings).toEqual([expect.stringContaining('agent "helper" revision 1')]);
  });

  it("keeps a waiting run's host text as its system messages and its task as an app part", async () => {
    const { agentId } = await addAgent('helper', { spec: 'cubicecho.agent/2', id: 'helper' });
    const kept = {
      messages: [{ role: 'user', content: 'hi' }],
      handedBack: [],
      appTools: [],
      loaded: [],
      hostText: 'You are in min-agent.',
      taskText: 'Ask about colours.',
      servers: null,
      sampling: { extraBody: {} },
    };
    const [run] = await db
      .insert(runs)
      .values({
        workspaceName: 'w',
        agentId,
        agentName: 'helper',
        status: RunStatus.Waiting,
        stream: false,
        // Written as the router kept it before the upgrade, which the type no longer describes.
        resume: JSON.parse(JSON.stringify(kept)) as RunResume,
      })
      .returning();
    await upgradeStored(db, recordingLog());
    const [row] = await db
      .select()
      .from(runs)
      .where(eq(runs.id, run?.id ?? ''));
    expect(row?.resume).toEqual({
      messages: kept.messages,
      handedBack: [],
      appTools: [],
      loaded: [],
      systemText: 'You are in min-agent.',
      appParts: [{ role: 'system', name: 'task', content: 'Ask about colours.' }],
      servers: null,
      sampling: { extraBody: {} },
    });
  });

  it('changes nothing the second time', async () => {
    await addAgent('helper', { spec: 'cubicecho.agent/1', id: 'helper', prompt: [{ id: 'identity', text: 'Hi.' }] });
    await upgradeStored(db, recordingLog());
    const before = await db.select().from(agentRevisions);
    const again = recordingLog();
    await upgradeStored(db, again);
    expect(await db.select().from(agentRevisions)).toEqual(before);
    expect(again.lines).toEqual([]);
    expect(again.warnings).toEqual([]);
  });
});
