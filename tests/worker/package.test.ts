import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorkerPackage, packageOf, WORKER_PACKAGE } from '../../scripts/worker-package.ts';

const run = promisify(execFile);

/** The repo's root. */
const ROOT = path.resolve(import.meta.dirname, '../..');
/** Where the worker program starts. */
const ENTRY = path.join(ROOT, 'worker/index.ts');
/** The server folders the worker must never load: the database and the snapshot built from it. */
const FORBIDDEN = ['server/db/'];
/** The version the test builds the package at. */
const VERSION = '9.8.7-test';
/** How long building, starting and removing the bundle may take: a checkout on a network share is slow. */
const SLOW_MS = 60_000;
/**
 * Every module a file loads when it runs: `import … from`, `export … from` and `import('…')`, but not
 * `import type` or `export type`, which Node's type stripping erases.
 */
const RUNTIME_SPECIFIER =
  /^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;
/** An import the bundle leaves for Node to resolve. */
const BUNDLE_IMPORT = /^import\s[^;]*?from\s*"([^"]+)"|^import\s*"([^"]+)"/gm;

/**
 * Follows the worker's runtime imports from its entry point.
 *
 * @returns Every file it loads, relative to the root.
 */
function workerFiles(): string[] {
  const files = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) {
      return;
    }
    files.add(file);
    for (const [, from, dynamic] of readFileSync(file, 'utf8').matchAll(RUNTIME_SPECIFIER)) {
      const specifier = from ?? dynamic ?? '';
      if (specifier.startsWith('.')) {
        visit(path.resolve(path.dirname(file), specifier));
      }
    }
  };
  visit(ENTRY);
  return [...files].map((file) => path.relative(ROOT, file)).sort();
}

describe('the worker package', () => {
  let outDir = '';
  let bundle = '';

  beforeAll(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), 'worker-package-'));
    bundle = await buildWorkerPackage({ outDir, version: VERSION });
    // The repo's node_modules beside it, so its imports resolve as an installed package's would.
    await symlink(path.join(ROOT, 'node_modules'), path.join(outDir, 'node_modules'));
  }, SLOW_MS);

  afterAll(async () => {
    await rm(outDir, { recursive: true, force: true });
  }, SLOW_MS);

  it('never loads the database or the snapshot', () => {
    expect(workerFiles().filter((file) => FORBIDDEN.some((folder) => file.startsWith(folder)))).toEqual([]);
  });

  it('leaves out only Node and its dependencies, and uses every one', async () => {
    const text = await readFile(bundle, 'utf8');
    const imported = new Set(
      [...text.matchAll(BUNDLE_IMPORT)]
        .map(([, from, bare]) => from ?? bare ?? '')
        .filter((specifier) => specifier.startsWith('node:') === false && builtinModules.includes(specifier) === false)
        .map(packageOf),
    );
    expect([...imported].sort()).toEqual([...WORKER_PACKAGE.dependencies].sort());
  });

  it('pins each dependency to the version the repo installs as a production dependency', async () => {
    const repo = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const manifest = JSON.parse(await readFile(path.join(outDir, 'package.json'), 'utf8')) as {
      version: string;
      bin: Record<string, string>;
      engines: { node: string };
      dependencies: Record<string, string>;
    };
    expect(manifest).toMatchObject({
      version: VERSION,
      bin: { [WORKER_PACKAGE.command]: WORKER_PACKAGE.entry },
      engines: { node: `>=${WORKER_PACKAGE.node}` },
    });
    for (const [name, pinned] of Object.entries(manifest.dependencies)) {
      expect(name in repo.dependencies).toBe(true);
      const installed = JSON.parse(await readFile(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8'));
      expect(pinned).toBe(installed.version);
    }
  });

  it(
    'carries its version written in, and starts far enough to refuse a missing router address',
    async () => {
      const text = await readFile(bundle, 'utf8');
      expect(text.startsWith('#!/usr/bin/env node\n')).toBe(true);
      expect(text).toContain(JSON.stringify(VERSION));
      expect(text).not.toContain('AI_ROUTER_WORKER_VERSION');

      const started = run(process.execPath, [bundle], { env: { PATH: process.env.PATH ?? '' } });
      await expect(started).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('AI_ROUTER_URL') });
    },
    SLOW_MS,
  );
});
