import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWorkerConfig, WorkerConfigError } from '../../worker/config.ts';

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'program-config-'));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/**
 * Builds a worker environment that reads well, with the root under the test's folder.
 *
 * @param [overrides] - Variables that differ.
 * @returns The environment.
 */
function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    AI_ROUTER_URL: 'http://router.lan:3000/',
    AI_ROUTER_WORKER_KEY: 'aiw_abc',
    WORKER_ROOT: join(folder, 'work'),
    ...overrides,
  };
}

describe('the worker config', () => {
  it('reads the environment and makes the work root', async () => {
    const config = readWorkerConfig(env({ WORKER_HOST: 'desk' }), folder);
    expect(config).toEqual({
      url: 'http://router.lan:3000',
      key: 'aiw_abc',
      root: join(folder, 'work'),
      host: 'desk',
      servers: {},
    });
    expect((await stat(config.root)).isDirectory()).toBe(true);
  });

  it('refuses a missing router address and a key that is not a worker key', () => {
    expect(() => readWorkerConfig(env({ AI_ROUTER_URL: undefined }), folder)).toThrow(WorkerConfigError);
    expect(() => readWorkerConfig(env({ AI_ROUTER_WORKER_KEY: 'air_app' }), folder)).toThrow('starts "aiw_"');
    expect(() => readWorkerConfig(env({ AI_ROUTER_WORKER_KEY: undefined }), folder)).toThrow('AI_ROUTER_WORKER_KEY');
  });

  it("reads the servers file, each command's folder relative to it", async () => {
    const file = join(folder, 'worker.json');
    await writeFile(
      file,
      JSON.stringify({
        servers: {
          tools: { command: 'npx', args: ['-y', 'some-mcp'], env: { A: 'b' }, cwd: 'here' },
          remote: { url: 'http://127.0.0.1:9000/mcp', headers: { authorization: 'Bearer x' } },
        },
      }),
    );
    const config = readWorkerConfig(env({ WORKER_CONFIG: 'worker.json' }), folder);
    expect(config.servers).toEqual({
      tools: { command: 'npx', args: ['-y', 'some-mcp'], env: { A: 'b' }, cwd: join(folder, 'here') },
      remote: { url: 'http://127.0.0.1:9000/mcp', headers: { authorization: 'Bearer x' } },
    });
  });

  it('refuses a servers file that is not JSON or has the wrong shape', async () => {
    const file = join(folder, 'worker.json');
    await writeFile(file, '{ not json');
    expect(() => readWorkerConfig(env({ WORKER_CONFIG: file }), folder)).toThrow("can't be read as JSON");
    await writeFile(file, JSON.stringify({ servers: { x: { command: '' } } }));
    expect(() => readWorkerConfig(env({ WORKER_CONFIG: file }), folder)).toThrow('servers.x');
  });
});
