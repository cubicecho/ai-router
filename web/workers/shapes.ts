import type { WorkerFieldsFragment } from '../__generated__/graphql';
import { NAME_HINT, NAME_PATTERN } from '../models/names';

/** The built-in worker's name: the router process itself, which has no key and is never deleted. */
export const LOCAL_WORKER_NAME = 'local';

/**
 * Whether a worker is the built-in one, inside the router.
 *
 * @param worker - The worker.
 * @returns true for `local`.
 */
export function isLocalWorker(worker: Pick<WorkerFieldsFragment, 'name'>): boolean {
  return worker.name === LOCAL_WORKER_NAME;
}

/**
 * Checks a new worker's name as the server will: a router name, and never the built-in worker's.
 *
 * @param value - The name as typed.
 * @returns What is wrong with it, or undefined.
 */
export function workerNameError(value: string): string | undefined {
  const name = value.trim();
  if (NAME_PATTERN.test(name) === false) {
    return NAME_HINT;
  }
  return name === LOCAL_WORKER_NAME ? `"${LOCAL_WORKER_NAME}" is kept for the worker inside the router.` : undefined;
}

/**
 * Puts the built-in worker first, and the rest in the order given.
 *
 * @typeParam T - The worker rows.
 * @param workers - The workers, as the query sorted them.
 * @returns A new list, `local` first.
 */
export function localFirst<T extends Pick<WorkerFieldsFragment, 'name'>>(workers: readonly T[]): T[] {
  return [...workers.filter(isLocalWorker), ...workers.filter((worker) => isLocalWorker(worker) === false)];
}

/**
 * Names a worker with the machine it said it runs on, when it has said.
 *
 * @param worker - The worker.
 * @returns Such as "build-box (ci-03)", or the name alone.
 */
export function workerLabelOf(worker: Pick<WorkerFieldsFragment, 'name' | 'host'>): string {
  return worker.host === null ? worker.name : `${worker.name} (${worker.host})`;
}

/** What a worker's status badge says, and the colour that repeats it. */
export const WorkerStatus = {
  /** The router itself: always there. */
  BuiltIn: 'built-in',
  /** It dialled in, and when it last did is known. */
  Seen: 'seen',
  /** It has never dialled in. */
  NeverSeen: 'never-seen',
} as const;

/** One of the statuses a worker's badge shows. */
export type WorkerStatus = (typeof WorkerStatus)[keyof typeof WorkerStatus];

/**
 * Reads where a worker stands. Today that is only whether it has ever dialled in; when the server says whether it is
 * connected, this is the one place that reads it.
 *
 * @param worker - The worker.
 * @returns Its status.
 */
export function workerStatusOf(worker: Pick<WorkerFieldsFragment, 'name' | 'lastSeenAt'>): WorkerStatus {
  if (isLocalWorker(worker)) {
    return WorkerStatus.BuiltIn;
  }
  return worker.lastSeenAt === null ? WorkerStatus.NeverSeen : WorkerStatus.Seen;
}

/**
 * The command that starts a worker on another machine, for the how-to beside the list.
 *
 * @param routerUrl - The router's address, as the person opened the UI at.
 * @param key - The worker's key, or a placeholder for it.
 * @returns One shell line.
 */
export function workerCommandOf(routerUrl: string, key: string): string {
  return `AI_ROUTER_URL=${routerUrl} AI_ROUTER_WORKER_KEY=${key} WORKER_ROOT=/srv/ai-router-worker npm run worker`;
}

/** What the how-to writes where a key belongs, before there is one to show. */
export const WORKER_KEY_PLACEHOLDER = 'aiw_…';
