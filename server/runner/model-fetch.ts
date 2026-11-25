import type { ResolvedAgent } from '@cubicecho/agent-core/spec';
import { MODELS_BASE_URL } from '../core/wire.ts';

/**
 * Gives every endpoint of a resolved agent that points at the router's models the run's `fetch`.
 *
 * @param resolved - The resolved agent.
 * @param fetch - The run's model `fetch`: `Forwarder.fetchFor` in the router.
 * @returns The config the loop runs with. An endpoint of the agent's own is left as it is, and called directly.
 */
export function withRouterFetch(resolved: ResolvedAgent, fetch: typeof globalThis.fetch): ResolvedAgent {
  const isRouter = (baseUrl: string): boolean => baseUrl === MODELS_BASE_URL;
  const tasks = Object.fromEntries(
    Object.entries(resolved.tasks).map(([name, task]) => [
      name,
      isRouter(task.endpoint.baseUrl) ? { ...task, endpoint: { ...task.endpoint, fetch } } : task,
    ]),
  );
  return { ...resolved, ...(isRouter(resolved.baseUrl) ? { fetch } : {}), tasks };
}
