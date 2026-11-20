import type { Snapshot, SnapshotServer } from '../db/snapshot.ts';

/** The servers a run reaches. */
export interface Reach {
  /** The enabled servers, in the order the list names them. */
  servers: SnapshotServer[];
  /** Names the agent lists that the router has no enabled server for. */
  missing: string[];
}

/**
 * Works out which servers a run reaches: those its workspace granted the agent, as the request narrowed them.
 *
 * @param servers - The resolved `tools.servers`, which `resolveRun` sets from the workspace's grant. Absent reaches
 * none: there is no "every server".
 * @param snapshot - The router's servers.
 * @returns The enabled servers it reaches, and the names it lists that aren't there or are turned off.
 *
 * @remarks
 * The agent's own document never adds a server, and neither does a workspace's server entry, which only configures
 * a server for that workspace's runs.
 */
export function reachOf(servers: readonly string[] | undefined, snapshot: Snapshot): Reach {
  const reached: SnapshotServer[] = [];
  const missing: string[] = [];
  for (const name of new Set(servers ?? [])) {
    const server = snapshot.servers.get(name);
    if (server?.enabled === true) {
      reached.push(server);
    } else {
      missing.push(name);
    }
  }
  return { servers: reached, missing };
}

/**
 * Narrows the servers a workspace granted an agent to those a request names. It never widens them.
 *
 * @param granted - The servers the workspace granted the agent.
 * @param requested - The servers the request names.
 * @param snapshot - The router's servers.
 * @returns The names in both, in the request's order: an exact list, so a narrowing to nothing means none.
 */
export function narrowedServers(
  granted: readonly string[],
  requested: readonly string[],
  snapshot: Snapshot,
): string[] {
  const reachable = new Set(reachOf(granted, snapshot).servers.map((server) => server.name));
  return [...new Set(requested)].filter((name) => reachable.has(name));
}
