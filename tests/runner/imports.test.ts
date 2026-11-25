import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** The server's source. */
const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '../../server');
/** The runner's folder, which a worker in another process runs with only JSON from the router. */
const RUNNER = join(SERVER, 'runner');
/** The server folders the runner may import from. */
const ALLOWED_FOLDERS = ['core', 'runner'];
/** The packages the runner may import from: zod, for the worker protocol's shapes. */
const ALLOWED_PACKAGES = ['@cubicecho/agent-core', '@cubicecho/agent-core/spec', 'zod'];
/** Every module specifier in a file: `from '…'`, `import '…'` and `import('…')`. */
const SPECIFIER = /(?:from\s+|import\s*\(?\s*)['"]([^'"]+)['"]/g;

/**
 * Lists a folder's TypeScript files, its subfolders' included.
 *
 * @param folder - The folder.
 * @returns Their absolute paths.
 */
function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe('the runner', () => {
  it('imports only from core, agent-core and zod', () => {
    const files = sourceFiles(RUNNER);
    expect(files.length).toBeGreaterThan(0);
    const strays = files.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].flatMap(([, specifier = '']) => {
        if (specifier.startsWith('.')) {
          const [folder = ''] = relative(SERVER, resolve(dirname(file), specifier)).split('/');
          return ALLOWED_FOLDERS.includes(folder) ? [] : [`${relative(SERVER, file)}: ${specifier}`];
        }
        return ALLOWED_PACKAGES.includes(specifier) ? [] : [`${relative(SERVER, file)}: ${specifier}`];
      }),
    );
    expect(strays).toEqual([]);
  });
});
