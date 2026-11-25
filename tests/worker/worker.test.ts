import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_SPEC, RunEventKind, type Runtime } from '@cubicecho/agent-core';
import { resolveAgentSpec } from '@cubicecho/agent-core/spec';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODELS_BASE_URL } from '../../server/core/wire.ts';
import {
  type RunAssignment,
  TOOL_ORIGIN_LOCAL,
  TOOL_ORIGIN_ROUTER,
  type ToolTarget,
} from '../../server/runner/assignment.ts';
import { ChannelMessageType, WorkerDoor } from '../../server/runner/protocol.ts';
import type { WorkerConfig } from '../../worker/config.ts';
import { RUN_DROPPED, WORKER_BUSY } from '../../worker/run.ts';
import { type RunningWorker, startWorker, type WorkerDeps } from '../../worker/worker.ts';
import { type FakeRouter, HANG, startFakeRouter } from './fake-router.ts';

/** The worker's key, as the fake router expects it. */
const KEY = 'aiw_test-key';
/** The local tool, as the model calls it. */
const LIST_DIR = 'workdir__list_dir';
/** The router tool, as the model calls it. */
const ECHO = 'fix_ture__echo';
/** The stdio fixture the tools tests use, which can grow a tool. */
const FIXTURE = fileURLToPath(new URL('../tools/fixtures/stdio-server.ts', import.meta.url));
/** Fast settings, so a test never waits on a real heartbeat or retry. */
const FAST = { eventFlushMs: 10, reconnectMinMs: 20, reconnectMaxMs: 50, sendRetryMs: 10, stopDeadlineMs: 2_000 };

/**
 * Builds a stretch that reaches `workdir`'s `list_dir` on the worker and the router's echo tool.
 *
 * @param runId - The run.
 * @returns The assignment.
 */
function assignment(runId: string): RunAssignment {
  const config = resolveAgentSpec([
    { spec: AGENT_SPEC, endpoint: { baseUrl: MODELS_BASE_URL }, model: { model: 'fake/m1' } },
  ]);
  const targets: Record<string, ToolTarget> = {
    [LIST_DIR]: { origin: TOOL_ORIGIN_LOCAL, server: 'workdir', tool: 'list_dir' },
    [ECHO]: { origin: TOOL_ORIGIN_ROUTER, server: 'server-1', tool: 'echo' },
  };
  return {
    runId,
    config,
    prompt: [],
    messages: [{ role: 'user', content: 'hello' }],
    loaded: [],
    tools: Object.keys(targets).map((name) => ({
      type: 'function' as const,
      function: { name, description: name, parameters: { type: 'object' } },
    })),
    catalog: [],
    targets,
    appTools: [],
  };
}

let router: FakeRouter;
let root: string;
let worker: RunningWorker | undefined;

/**
 * Starts a worker against the fake router, and waits for its hello.
 *
 * @param [overrides] - Config and deps that differ.
 * @returns The worker.
 */
async function start(overrides: { config?: Partial<WorkerConfig>; deps?: WorkerDeps } = {}): Promise<RunningWorker> {
  const config: WorkerConfig = { url: router.url, key: KEY, root, host: 'test-host', servers: {}, ...overrides.config };
  const deps = overrides.deps ?? {};
  worker = await startWorker(config, { ...deps, settings: { ...FAST, ...deps.settings } });
  await vi.waitFor(() => expect(router.hellos.length).toBeGreaterThan(0));
  return worker;
}

beforeEach(async () => {
  router = await startFakeRouter();
  root = await mkdtemp(join(tmpdir(), 'program-worker-'));
});

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await router.close();
  await rm(root, { recursive: true, force: true });
});

describe('the worker program', () => {
  it("dials in with its key and says workdir's tools in its hello", async () => {
    await start();
    const [hello] = router.hellos;
    expect(hello?.host).toBe('test-host');
    expect(hello?.servers.map(({ name }) => name)).toEqual(['workdir']);
    expect(hello?.servers[0]?.tools.map(({ name }) => name).sort()).toEqual(['list_dir', 'open_repo']);
    const channel = router.heard.find(({ path }) => path === '/workers/channel');
    expect(channel?.authorization).toBe(`Bearer ${KEY}`);
    expect(router.heard.every(({ authorization }) => authorization === `Bearer ${KEY}`)).toBe(true);
  });

  it('runs a local tool itself, sends a router tool to the tools door, and finishes ok', async () => {
    await writeFile(join(root, 'notes.txt'), 'hi');
    router.replies.push(
      { id: 'c1', name: LIST_DIR, args: { path: '.' } },
      { id: 'c2', name: ECHO, args: { text: 'hi' } },
      'all done',
    );
    await start();
    router.send(ChannelMessageType.Assign, { type: ChannelMessageType.Assign, assignment: assignment('run-1') });
    await vi.waitFor(() => expect(router.finishes.has('run-1')).toBe(true));

    const outcome = router.finishes.get('run-1');
    expect(outcome?.ok).toBe(true);
    expect(router.toolCalls).toEqual([
      { server: 'server-1', tool: 'echo', args: { text: 'hi' }, call: { id: expect.any(String), name: ECHO } },
    ]);
    const transcript = JSON.stringify(outcome?.ok ? outcome.messages : []);
    expect(transcript).toContain('notes.txt');
    expect(transcript).toContain('all done');

    const events = router.events.get('run-1') ?? [];
    const results = events.filter(({ kind }) => kind === RunEventKind.ToolResult).map(({ name }) => name);
    expect(results).toEqual([LIST_DIR, ECHO]);
    // Every event arrived before the finish was sent.
    const finishAt = router.heard.findIndex(({ path }) => path.endsWith(WorkerDoor.Finish));
    const lastEventsAt = router.heard.findLastIndex(({ path }) => path.endsWith(WorkerDoor.Events));
    expect(lastEventsAt).toBeLessThan(finishAt);
  });

  it('aborts a run on its cancel, and finishes it failed with the reason', async () => {
    router.replies.push(HANG);
    await start();
    router.send(ChannelMessageType.Assign, { assignment: assignment('run-2') });
    await vi.waitFor(() => expect(router.modelCalls.length).toBe(1));
    router.send(ChannelMessageType.Cancel, { runId: 'run-2', reason: 'the app left' });
    await vi.waitFor(() => expect(router.finishes.has('run-2')).toBe(true));
    expect(router.finishes.get('run-2')).toMatchObject({ ok: false, error: 'the app left' });
    expect(worker?.runs.held()).toBe(0);
  });

  it('sends model calls to the model door with its key, and refuses every other address', async () => {
    const elsewhere: string[] = [];
    const other = createServer((req, res) => {
      elsewhere.push(req.url ?? '');
      res.end('{}');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const { port } = other.address() as AddressInfo;
    const tried: { url: string; outcome: string }[] = [];
    const runtime: Pick<Runtime, 'runAgentLoop'> = {
      runAgentLoop: async ({ config }) => {
        const fetch = config.fetch ?? globalThis.fetch;
        for (const url of [`${MODELS_BASE_URL}/models`, `http://127.0.0.1:${port}/v1/models`]) {
          try {
            const response = await fetch(url);
            tried.push({ url, outcome: String(response.status) });
          } catch (error) {
            tried.push({ url, outcome: error instanceof Error ? error.message : String(error) });
          }
        }
        throw new Error('done looking');
      },
    };
    try {
      await start({ deps: { runtime } });
      router.send(ChannelMessageType.Assign, { assignment: assignment('run-3') });
      await vi.waitFor(() => expect(router.finishes.has('run-3')).toBe(true));
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
    expect(router.modelCalls).toEqual([{ runId: 'run-3', path: '/models', authorization: `Bearer ${KEY}` }]);
    expect(tried[1]?.outcome).toContain("may call only the router's models");
    expect(elsewhere).toEqual([]);
    expect(router.finishes.get('run-3')).toMatchObject({ ok: false, error: 'done looking' });
  });

  it('stops a run whose door answers 404, and sends it no finish', async () => {
    router.replies.push({ id: 'c1', name: ECHO, args: { text: 'hi' } }, 'never reached');
    router.notFound.set('run-4', new Set([WorkerDoor.Tools]));
    await start();
    router.send(ChannelMessageType.Assign, { assignment: assignment('run-4') });
    await vi.waitFor(() => expect(router.heard.some(({ path }) => path.endsWith(WorkerDoor.Tools))).toBe(true));
    await vi.waitFor(() => expect(worker?.runs.held()).toBe(0));
    expect(router.modelCalls).toHaveLength(1);
    expect(router.toolCalls).toEqual([]);
    expect(router.finishes.has('run-4')).toBe(false);
    expect(router.heard.some(({ path }) => path.endsWith(WorkerDoor.Finish))).toBe(false);
    expect(RUN_DROPPED).toBe('the router dropped this run');
  });

  it("stops a run when the model door's own 404 says the router dropped it", async () => {
    router.notFound.set('run-4b', new Set([WorkerDoor.Model]));
    await start();
    router.send(ChannelMessageType.Assign, { assignment: assignment('run-4b') });
    await vi.waitFor(() => expect(router.heard.some(({ path }) => path.endsWith('/chat/completions'))).toBe(true));
    await vi.waitFor(() => expect(worker?.runs.held()).toBe(0));
    expect(router.finishes.has('run-4b')).toBe(false);
  });

  it('finishes an assignment past its cap at once, as busy', async () => {
    router.replies.push(HANG);
    await start({ deps: { settings: { maxRunsAtOnce: 1 } } });
    router.send(ChannelMessageType.Assign, { assignment: assignment('run-5') });
    await vi.waitFor(() => expect(router.modelCalls.length).toBe(1));
    router.send(ChannelMessageType.Assign, { assignment: assignment('run-6') });
    await vi.waitFor(() => expect(router.finishes.has('run-6')).toBe(true));
    expect(router.finishes.get('run-6')).toMatchObject({ ok: false, error: WORKER_BUSY });
    expect(worker?.runs.held()).toBe(1);
  });

  it('dials in again when the channel drops, keeps its run going, and says hello again', async () => {
    router.replies.push(HANG);
    await start();
    router.send(ChannelMessageType.Assign, { assignment: assignment('run-7') });
    await vi.waitFor(() => expect(router.modelCalls.length).toBe(1));
    router.dropChannels();
    await vi.waitFor(() => expect(router.hellos.length).toBe(2));
    expect(worker?.runs.held()).toBe(1);
    router.send(ChannelMessageType.Cancel, { runId: 'run-7', reason: 'over' });
    await vi.waitFor(() => expect(router.finishes.get('run-7')).toMatchObject({ ok: false, error: 'over' }));
  });

  it('treats a silent channel as dead', async () => {
    await start({ deps: { settings: { heartbeatMs: 30, silentHeartbeats: 2 } } });
    await vi.waitFor(() => expect(router.hellos.length).toBeGreaterThanOrEqual(2));
  });

  it('says a new hello when a local server says its tools changed', async () => {
    await start({ config: { servers: { fixture: { command: process.execPath, args: [FIXTURE] } } } });
    const fixtureTools = (index: number) =>
      router.hellos[index]?.servers.find(({ name }) => name === 'fixture')?.tools.map(({ name }) => name) ?? [];
    expect(fixtureTools(0)).not.toContain('extra');
    await worker?.local.callTool('fixture', 'grow', {}, AbortSignal.timeout(5_000));
    await vi.waitFor(() => expect(router.hellos.length).toBe(2));
    expect(fixtureTools(1)).toContain('extra');
  });

  it('finishes its runs as failed when it stops', async () => {
    router.replies.push(HANG);
    const running = await start();
    router.send(ChannelMessageType.Assign, { assignment: assignment('run-8') });
    await vi.waitFor(() => expect(router.modelCalls.length).toBe(1));
    await running.stop();
    worker = undefined;
    expect(router.finishes.get('run-8')).toMatchObject({ ok: false, error: 'the worker is stopping' });
  });
});
