import type { SnapshotServer, SnapshotServerEntry } from '../db/snapshot.ts';
import { installFolderPath } from './install-folder.ts';
import { type ResolvedServer, TRANSPORT_STDIO } from './shapes.ts';

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
 * Env and headers merge, the workspace's winning. Arguments and the address replace the server's.
 */
export function resolveServer(
  server: SnapshotServer,
  workspaceId: string | null,
  defaults: ServerTimeouts,
  root?: string,
): ResolvedServer {
  const found = workspaceId === null ? undefined : server.entries.get(workspaceId);
  const entry = found !== undefined && overridesSomething(found) ? found : undefined;
  const common = {
    id: server.id,
    name: server.name,
    workspaceId: entry === undefined ? null : workspaceId,
    idleTimeoutMs: server.idleTimeoutMs ?? defaults.idleTimeoutMs,
    callTimeoutMs: server.callTimeoutMs ?? defaults.callTimeoutMs,
  };
  const { transport } = server;
  if (transport.type === TRANSPORT_STDIO) {
    return {
      ...common,
      transport: {
        type: TRANSPORT_STDIO,
        command: transport.command,
        args: [...(entry?.args ?? transport.args)],
        ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
      },
      env: { ...server.env, ...entry?.env },
      childUid: server.childUid,
      installDir: server.installDir === null ? null : installFolderPath(server.installDir, server.childUid, root),
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
    childUid: null,
    installDir: null,
  };
}
