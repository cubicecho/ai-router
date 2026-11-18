import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { count } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../server/db/client.ts';
import { workspaces } from '../../server/db/schema.ts';

/** A pid above Linux's default `pid_max`, so no process has it. */
const DEAD_PID = 4_194_305;
/** Booting PGlite and migrating takes seconds on a busy machine. */
const BOOT_TIMEOUT_MS = 30_000;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai-router-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('PGlite under DATA_DIR', () => {
  it(
    'migrates on boot, so the tables exist',
    async () => {
      const database = openDatabase('', dir);
      await database.claim();
      await database.migrate();
      const rows = await database.db.select({ total: count() }).from(workspaces);
      expect(rows).toEqual([{ total: 0 }]);
      await database.close();
    },
    BOOT_TIMEOUT_MS,
  );

  it('refuses a directory another live process holds', async () => {
    await writeFile(path.join(dir, 'pg.lock'), `${process.ppid}\n`);
    expect(() => openDatabase('', dir)).toThrow(`already open by process ${process.ppid}`);
  });

  it('takes over a lock its holder left behind, and releases it on close', async () => {
    await writeFile(path.join(dir, 'pg.lock'), `${DEAD_PID}\n`);
    const database = openDatabase('', dir);
    expect(await readFile(path.join(dir, 'pg.lock'), 'utf8')).toBe(`${process.pid}\n`);
    await database.close();
    await expect(readFile(path.join(dir, 'pg.lock'), 'utf8')).rejects.toThrow();
  });
});
