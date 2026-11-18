import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT } from '../../server/core/config.ts';

/** The migration that gives stored events agent-core 5.0's names. */
const MIGRATION = path.join(ROOT, 'drizzle', '20261118235114_run_events_exchange', 'migration.sql');

describe('the run_events exchange migration', () => {
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite('memory://');
    await client.exec('create table run_events (seq integer primary key, kind text not null, event jsonb not null)');
  });

  afterAll(() => client.close());

  it("renames a stored event's step, and the step kind, and leaves new events alone", async () => {
    await client.exec(`insert into run_events values
      (1, 'step', '{"kind":"step","step":"","name":"plan","seq":1}'),
      (2, 'output', '{"kind":"output","step":"plan","text":"a","seq":2}'),
      (3, 'output', '{"kind":"output","exchange":"plan","text":"b","seq":3}')`);
    const sql = await readFile(MIGRATION, 'utf-8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      await client.exec(statement);
    }
    const { rows } = await client.query<{ kind: string; event: Record<string, unknown> }>(
      'select kind, event from run_events order by seq',
    );
    expect(rows).toEqual([
      { kind: 'exchange', event: { kind: 'exchange', exchange: '', name: 'plan', seq: 1 } },
      { kind: 'output', event: { kind: 'output', exchange: 'plan', text: 'a', seq: 2 } },
      { kind: 'output', event: { kind: 'output', exchange: 'plan', text: 'b', seq: 3 } },
    ]);
  });
});
