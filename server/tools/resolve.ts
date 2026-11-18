import { ADMIN_ROLES } from '../core/admin-roles.ts';
import type { SnapshotServer, SnapshotServerEntry } from '../db/snapshot.ts';
import type { ChildUser } from './child-users.ts';
import { homeOf, installFolderPath } from './install-folder.ts';
import { type ResolvedServer, TRANSPORT_BUILTIN, TRANSPORT_STDIO } from './shapes.ts';

/** The timeouts a server gets when it sets none of its own. */
export interface ServerTimeouts {
  idleTimeoutMs: number;
  callTimeoutMs: number;
}

/**
 * Whether an entry changes anything, and so needs an instance of its own.
 *
 * @param entry - A workspace's entry for a server.
 * @returns true when it sets env, headers, arguments or an address.
 */
function overridesSomething(entry: SnapshotServerEntry): boolean {
  return (
    Object.keys(entry.env).length > 0 ||
    Object.keys(entry.headers).length > 0 ||
    entry.args !== null ||
    entry.url !== null
  );
}

/**
 * Names the path of a stored folder.
 *
 * @param name - The folder's name, or null when none is made.
 * @param uid - Its owner, whose uid the name starts with.
 * @param [root] - Where folders are.
 * @returns The absolute path, or null.
 */
function folderPath(name: string | null, uid: number, root?: string): string | null {
  return name === null ? null : installFolderPath(name, uid, root);
}

/**
 * Finds the entry a workspace's runs use an instance of their own for.
 *
 * @param server - The server, from the snapshot.
 * @param workspaceId - The workspace whose run calls it, or null.
 * @returns Its entry when it overrides something; undefined when the base instance is used.
 */
export function workspaceInstanceEntry(
  server: SnapshotServer,
  workspaceId: string | null,
): SnapshotServerEntry | undefined {
  const found = workspaceId === null ? undefined : server.entries.get(workspaceId);
  return found !== undefined && overridesSomething(found) ? found : undefined;
}

/**
 * Works out what an instance of a server runs with: the base instance, or one workspace's, with that
 * workspace's entry merged over the server's settings.
 *
 * @param server - The server, from the snapshot.
 * @param workspaceId - The workspace whose run calls it. null, or a workspace whose entry overrides nothing, gets
 * the base instance.
 * @param defaults - The timeouts for a server that sets none.
 * @param [root] - Where install folders are; `serversDir()` when absent.
 * @returns What `tools/instance` starts or connects to.
 *
 * @remarks
 * Env and headers merge, the workspace's winning. Arguments and the address replace the server's. A stdio workspace
 * instance runs as its entry's own uid, with the server's group and extra groups, in the server's install folder,
 * with the entry's folder as its HOME. The admin server has an instance per workspace, entry or not, granting its
 * entry's roles, and a base instance granting every role, which only lists its tools for a person.
 */
export function resolveServer(
  server: SnapshotServer,
  workspaceId: string | null,
  defaults: ServerTimeouts,
  root?: string,
): ResolvedServer {
  const entry = workspaceInstanceEntry(server, workspaceId);
  const common = {
    id: server.id,
    name: server.name,
    workspaceId: entry === undefined ? null : workspaceId,
    idleTimeoutMs: server.idleTimeoutMs ?? defaults.idleTimeoutMs,
    callTimeoutMs: server.callTimeoutMs ?? defaults.callTimeoutMs,
  };
  const { transport } = server;
  if (transport.type === TRANSPORT_BUILTIN) {
    const roles = workspaceId === null ? ADMIN_ROLES : (server.entries.get(workspaceId)?.roles ?? []);
    return {
      ...common,
      workspaceId,
      transport: { type: TRANSPORT_BUILTIN, roles: [...roles] },
      env: {},
      runAs: null,
      installDir: null,
      homeDir: null,
    };
  }
  if (transport.type === TRANSPORT_STDIO) {
    const runAs: ChildUser = {
      uid: entry?.childUid ?? server.childUid,
      gid: server.childUid,
      groups: [...server.extraGroups],
    };
    const installDir = folderPath(server.installDir, server.childUid, root);
    const ownFolder = entry === undefined ? installDir : folderPath(entry.installDir, entry.childUid, root);
    return {
      ...common,
      transport: {
        type: TRANSPORT_STDIO,
        command: transport.command,
        args: [...(entry?.args ?? transport.args)],
        ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
      },
      env: { ...server.env, ...entry?.env },
      runAs,
      installDir,
      homeDir: ownFolder === null ? null : homeOf(ownFolder),
    };
  }
  return {
    ...common,
    transport: {
      type: transport.type,
      url: entry?.url ?? transport.url,
      headers: { ...server.headers, ...entry?.headers },
    },
    env: {},
    runAs: null,
    installDir: null,
    homeDir: null,
  };
}
