import type { Snapshot, SnapshotServer } from '../db/snapshot.ts';
import { RESERVED_SERVER_NAME } from '../tools/shapes.ts';

/** The servers a run reaches. */
export interface Reach {
  /** The enabled servers, in the order the agent names them, or the snapshot's for every server. */
  servers: SnapshotServer[];
  /** Names the agent lists that the router has no enabled server for. */
  missing: string[];
}

/**
 * Works out which servers a run reaches, from the agent's own list and never the workspace's.
 *
 * @param servers - The resolved `tools.servers`: absent for every server, `[]` for none, a list for exactly those.
 * @param snapshot - The router's servers.
 * @returns The enabled servers it reaches, and the names it lists that aren't there or are turned off.
 *
 * @remarks
 * "Every server" never holds the admin server, which an agent reaches only by naming it. A workspace's server
 * entries configure these servers for its runs, and never add one.
 */
export function reachOf(servers: readonly string[] | undefined, snapshot: Snapshot): Reach {
  if (servers === undefined) {
    const every = [...snapshot.servers.values()].filter(
      (server) => server.enabled && server.name !== RESERVED_SERVER_NAME,
    );
    return { servers: every, missing: [] };
  }
  const reached: SnapshotServer[] = [];
  const missing: string[] = [];
  for (const name of new Set(servers)) {
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
 * Narrows an agent's reach to the servers a request names. It never widens it.
 *
 * @param agentServers - The agent's own resolved `tools.servers`.
 * @param requested - The servers the request names.
 * @param snapshot - The router's servers, for an agent that reaches every one.
 * @returns The names in both, in the request's order: an exact list, so a narrowing to nothing means none.
 */
export function narrowedServers(
  agentServers: readonly string[] | undefined,
  requested: readonly string[],
  snapshot: Snapshot,
): string[] {
  const reachable = new Set(reachOf(agentServers, snapshot).servers.map((server) => server.name));
  return [...new Set(requested)].filter((name) => reachable.has(name));
}
