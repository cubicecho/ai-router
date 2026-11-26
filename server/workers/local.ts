import type { Runtime } from '@cubicecho/agent-core';
import { executeRun } from '../runner/execute.ts';
import type { RunWorker } from './worker.ts';

/**
 * Builds the built-in `local` worker, which runs loops in the router's own process with the router's ports as they are.
 *
 * @param runtime - agent-core's runtime, whose caches its loops share.
 * @returns The worker.
 */
export function createLocalWorker(runtime: Pick<Runtime, 'runAgentLoop'>): RunWorker {
  return { execute: (assignment, ports) => executeRun(assignment, ports, runtime) };
}
