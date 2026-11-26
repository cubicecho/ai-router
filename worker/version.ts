import { version } from '../server/core/config.ts';

/**
 * The worker package's version, written in as a string by `scripts/worker-package.ts` when it bundles the worker.
 * Run from a checkout, nothing writes it, and it is not defined.
 */
declare const AI_ROUTER_WORKER_VERSION: string | undefined;

/**
 * Says which version of the worker program this is: the bundled package's own, or, from a checkout, the repo's.
 *
 * @returns The version, as the hello and the MCP clients name it.
 *
 * @remarks
 * A bundle can't read the repo's package.json the way `version()` does, because it isn't there.
 */
export function workerVersion(): string {
  return typeof AI_ROUTER_WORKER_VERSION === 'string' ? AI_ROUTER_WORKER_VERSION : version();
}
