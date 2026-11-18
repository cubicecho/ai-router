import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHILD_DEFAULTS } from '../../server/core/defaults.ts';
import { ChildMode, checkChildIsolation } from '../../server/tools/child-users.ts';

let dir: string;

/**
 * Writes a stand-in for the helper.
 *
 * @param name - Its file name.
 * @param body - The shell script it runs.
 * @returns Its path.
 */
async function fakeHelper(name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ai-router-children-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('checkChildIsolation', () => {
  it('is isolated when the helper switches into the range', async () => {
    const helperPath = await fakeHelper('switches', `echo ${CHILD_DEFAULTS.uidMin}`);
    expect(await checkChildIsolation({ helperPath, production: true })).toEqual({
      mode: ChildMode.Isolated,
      reason: '',
    });
  });

  it('shares the router user in development when there is no helper', async () => {
    const result = await checkChildIsolation({ helperPath: path.join(dir, 'missing'), production: false });
    expect(result.mode).toBe(ChildMode.Shared);
    expect(result.reason).toContain('refused when NODE_ENV=production');
  });

  it('refuses in production when there is no helper', async () => {
    const result = await checkChildIsolation({ helperPath: path.join(dir, 'missing'), production: true });
    expect(result.mode).toBe(ChildMode.Refused);
  });

  it('refuses when the helper cannot switch, as under no-new-privileges', async () => {
    const helperPath = await fakeHelper('fails', 'echo "run-as-child: setgroups failed" >&2; exit 126');
    const result = await checkChildIsolation({ helperPath, production: false });
    expect(result.mode).toBe(ChildMode.Refused);
    expect(result.reason).toContain('no-new-privileges');
  });

  it('refuses when the helper runs the command as someone else', async () => {
    const helperPath = await fakeHelper('wrong-user', 'echo 1000');
    const result = await checkChildIsolation({ helperPath, production: false });
    expect(result).toMatchObject({ mode: ChildMode.Refused });
    expect(result.reason).toContain('as uid 1000');
  });
});
