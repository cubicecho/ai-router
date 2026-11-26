import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The repo's root. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Where the worker program starts. */
const ENTRY = resolve(ROOT, 'worker/index.ts');
/** The server folders the worker must never load: the database and the snapshot built from it. */
const FORBIDDEN = ['server/db/'];
/**
 * Every module a file loads when it runs: `import … from`, `export … from` and `import('…')`, but not
 * `import type` or `export type`, which Node's type stripping erases.
 */
const RUNTIME_SPECIFIER =
  /^\s*(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

/** What the worker loads when it starts: its files, relative to the root, and the packages it names. */
interface ImportGraph {
  files: string[];
  packages: string[];
}

/**
 * Follows the worker's runtime imports from its entry point.
 *
 * @returns Every file and package it loads.
 */
function workerGraph(): ImportGraph {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) {
      return;
    }
    files.add(file);
    for (const [, from, dynamic] of readFileSync(file, 'utf8').matchAll(RUNTIME_SPECIFIER)) {
      const specifier = from ?? dynamic ?? '';
      if (specifier.startsWith('.')) {
        visit(resolve(dirname(file), specifier));
      } else {
        packages.add(specifier);
      }
    }
  };
  visit(ENTRY);
  return { files: [...files].map((file) => relative(ROOT, file)).sort(), packages: [...packages] };
}

/**
 * Reads what the Dockerfile's worker stage copies from the build context.
 *
 * @returns Each `COPY` source, relative to the root; a folder ends in `/`.
 */
function workerStageSources(): string[] {
  const stage = readFileSync(resolve(ROOT, 'Dockerfile'), 'utf8')
    .split(/^FROM\s+/m)
    .find((part) => /\sAS worker\b/.test(part.split('\n')[0] ?? ''));
  if (stage === undefined) {
    throw new Error('The Dockerfile has no worker stage.');
  }
  return stage
    .split('\n')
    .filter((line) => line.startsWith('COPY ') && line.includes('--from') === false)
    .flatMap((line) => line.slice('COPY '.length).trim().split(/\s+/).slice(0, -1))
    .map((source) => (source.endsWith('.ts') || source.endsWith('.json') ? source : `${source.replace(/\/$/, '')}/`));
}

/**
 * Names the package a bare specifier is from.
 *
 * @param specifier - Such as `@modelcontextprotocol/sdk/types.js` or `zod`.
 * @returns Such as `@modelcontextprotocol/sdk` or `zod`.
 */
function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
}

describe('the worker image', () => {
  const graph = workerGraph();

  it('never loads the database or the snapshot', () => {
    expect(graph.files.filter((file) => FORBIDDEN.some((folder) => file.startsWith(folder)))).toEqual([]);
  });

  it('copies every file the worker loads', () => {
    const sources = workerStageSources();
    const missing = graph.files.filter(
      (file) => sources.some((source) => (source.endsWith('/') ? file.startsWith(source) : file === source)) === false,
    );
    expect(missing).toEqual([]);
  });

  it('loads only packages a production install has', () => {
    const { dependencies } = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const builtins = new Set(builtinModules);
    const strays = graph.packages
      .filter((specifier) => specifier.startsWith('node:') === false && builtins.has(specifier) === false)
      .map(packageOf)
      .filter((name) => name in dependencies === false);
    expect(strays).toEqual([]);
  });
});
