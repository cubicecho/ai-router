import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { build } from 'rolldown';

/** The repo's root. */
const ROOT = path.resolve(import.meta.dirname, '..');

/** The worker package: what it is called, what it installs, and the oldest Node it runs on. */
export const WORKER_PACKAGE = Object.freeze({
  name: '@cubicecho/ai-router-worker',
  /** The command its `bin` puts on the PATH. */
  command: 'ai-router-worker',
  /** The bundle, at the package's root. */
  entry: 'worker.js',
  /** agent-core's own floor. */
  node: '22',
  /**
   * The packages the bundle leaves as imports, installed beside it at the versions this repo has. Everything else the
   * worker loads is bundled in, or left out as unused. `tests/worker/package.test.ts` checks this against the
   * bundle's imports.
   */
  dependencies: ['@cubicecho/agent-core', '@modelcontextprotocol/sdk', 'eventsource-parser', 'zod'],
});

/** Where `npm run build:worker` writes the package: its folder is what `npm pack` packs. */
export const WORKER_PACKAGE_DIR = path.join(ROOT, 'dist-worker');

/** What building the package needs. */
export interface WorkerPackageOptions {
  /** The folder to write it to. Emptied first. */
  outDir: string;
  /** Its version. */
  version: string;
}

/**
 * Names the package a bare specifier is from.
 *
 * @param specifier - Such as `@modelcontextprotocol/sdk/types.js` or `zod`.
 * @returns Such as `@modelcontextprotocol/sdk` or `zod`.
 */
export function packageOf(specifier: string): string {
  const parts = specifier.split('/');
  return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
}

/**
 * Whether the bundle leaves an import as it is: Node's own modules and the package's dependencies.
 *
 * @param specifier - What a file imports.
 * @returns true to leave it out of the bundle.
 */
function isExternal(specifier: string): boolean {
  if (specifier.startsWith('node:') || builtinModules.includes(specifier)) {
    return true;
  }
  return WORKER_PACKAGE.dependencies.includes(packageOf(specifier));
}

/**
 * Reads the version this repo installs of a dependency, so the package pins the one the tests ran against.
 *
 * @param name - The dependency.
 * @returns Its installed version.
 */
async function installedVersion(name: string): Promise<string> {
  // Read from node_modules, not resolved: a package whose exports leave out package.json can't be required for it.
  const file = path.join(ROOT, 'node_modules', name, 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8')) as { version: string };
  return manifest.version;
}

/**
 * Builds the worker package: the worker program bundled into one file that runs on Node 22, its manifest, and its
 * README and licence.
 *
 * @param options - Where to write it, and its version.
 * @returns The bundle's path.
 */
export async function buildWorkerPackage({ outDir, version }: WorkerPackageOptions): Promise<string> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const bundle = path.join(outDir, WORKER_PACKAGE.entry);
  await build({
    input: path.join(ROOT, 'worker/index.ts'),
    platform: 'node',
    external: isExternal,
    transform: {
      target: `node${WORKER_PACKAGE.node}`,
      define: { AI_ROUTER_WORKER_VERSION: JSON.stringify(version) },
    },
    output: { file: bundle, format: 'esm', banner: '#!/usr/bin/env node' },
    logLevel: 'warn',
  });
  await chmod(bundle, 0o755);

  const manifest = {
    name: WORKER_PACKAGE.name,
    version,
    description: "ai-router's worker program: runs a workspace's agent loops on another machine.",
    license: 'MIT',
    type: 'module',
    bin: { [WORKER_PACKAGE.command]: WORKER_PACKAGE.entry },
    files: [WORKER_PACKAGE.entry, 'README.md', 'LICENSE'],
    engines: { node: `>=${WORKER_PACKAGE.node}` },
    repository: { type: 'git', url: 'git+https://github.com/cubicecho/ai-router.git' },
    dependencies: Object.fromEntries(
      await Promise.all(WORKER_PACKAGE.dependencies.map(async (name) => [name, await installedVersion(name)])),
    ),
  };
  await writeFile(path.join(outDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await copyFile(path.join(ROOT, 'LICENSE'), path.join(outDir, 'LICENSE'));
  await writeFile(
    path.join(outDir, 'README.md'),
    [
      `# ${WORKER_PACKAGE.name}`,
      '',
      "ai-router's worker program. It dials a router with a worker key and runs the agent loops of the workspaces",
      'that name it, with its own MCP servers beside the router\'s. See "Running a worker" in',
      "[ai-router's README](https://github.com/cubicecho/ai-router#running-a-worker).",
      '',
      '```bash',
      `AI_ROUTER_URL=http://router.lan:3000 AI_ROUTER_WORKER_KEY=aiw_... ${WORKER_PACKAGE.command}`,
      '```',
      '',
      `Node ${WORKER_PACKAGE.node} or later.`,
      '',
    ].join('\n'),
  );
  return bundle;
}

/**
 * Reads the repo's version, which the package takes unless `WORKER_VERSION` names another.
 *
 * @returns The version.
 */
export async function repoVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')) as { version: string };
  return manifest.version;
}
