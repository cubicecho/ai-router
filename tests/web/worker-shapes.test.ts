import { describe, expect, it } from 'vitest';
import { LOCAL_WORKER_NAME as SERVER_LOCAL_WORKER_NAME } from '../../server/db/tables/workers.ts';
import { workerInput } from '../../server/workers/input.ts';
import {
  isLocalWorker,
  LOCAL_WORKER_NAME,
  localFirst,
  WorkerStatus,
  workerCommandOf,
  workerLabelOf,
  workerNameError,
  workerStatusOf,
} from '../../web/workers/shapes.ts';

const SEEN = '2026-11-25T10:00:00.000Z';

describe("the UI's workers", () => {
  it('name the built-in worker as the router does', () => {
    expect(LOCAL_WORKER_NAME).toBe(SERVER_LOCAL_WORKER_NAME);
    expect(isLocalWorker({ name: 'local' })).toBe(true);
    expect(isLocalWorker({ name: 'build-box' })).toBe(false);
  });

  it('put local first and keep the rest in order', () => {
    const rows = [{ name: 'alpha' }, { name: 'local' }, { name: 'zeta' }];
    expect(localFirst(rows).map((row) => row.name)).toEqual(['local', 'alpha', 'zeta']);
    expect(rows.map((row) => row.name)).toEqual(['alpha', 'local', 'zeta']);
  });

  it('add the host to a name only when the worker has said it', () => {
    expect(workerLabelOf({ name: 'build-box', host: 'ci-03' })).toBe('build-box (ci-03)');
    expect(workerLabelOf({ name: 'build-box', host: null })).toBe('build-box');
  });

  it('read a status from whether the worker has ever connected', () => {
    expect(workerStatusOf({ name: 'local', lastSeenAt: null })).toBe(WorkerStatus.BuiltIn);
    expect(workerStatusOf({ name: 'build-box', lastSeenAt: null })).toBe(WorkerStatus.NeverSeen);
    expect(workerStatusOf({ name: 'build-box', lastSeenAt: SEEN })).toBe(WorkerStatus.Seen);
  });

  it('refuse the names the server refuses, and accept the ones it accepts', () => {
    for (const name of ['build-box', 'ci.03', 'a_b', '  padded  ']) {
      expect(workerNameError(name)).toBeUndefined();
      expect(workerInput.safeParse({ name }).success).toBe(true);
    }
    for (const name of ['', 'Build', '-lead', 'has space', 'local']) {
      expect(workerNameError(name)).toBeDefined();
      expect(workerInput.safeParse({ name }).success).toBe(false);
    }
  });

  it('write the command that starts a worker', () => {
    expect(workerCommandOf('https://router.lan', 'aiw_abc')).toBe(
      'AI_ROUTER_URL=https://router.lan AI_ROUTER_WORKER_KEY=aiw_abc WORKER_ROOT=/srv/ai-router-worker npm run worker',
    );
  });
});
