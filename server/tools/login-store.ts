import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import type { SnapshotHost } from '../db/snapshot.ts';
import { servers } from '../db/tables/servers.ts';
import type { ServerLoginStore } from './oauth/provider.ts';
import { isHttpTransport } from './shapes.ts';

/**
 * Keeps server logins in `servers.oauth`, reading them from the snapshot.
 *
 * @param db - Where a login is written.
 * @param snapshot - Where it is read, since every request an instance sends reads it.
 * @returns The store the login service uses.
 */
export function createServerLoginStore(db: DB, snapshot: SnapshotHost): ServerLoginStore {
  return {
    async load(serverId) {
      const server = [...snapshot.current().servers.values()].find((candidate) => candidate.id === serverId);
      if (server === undefined || isHttpTransport(server.transport) === false) {
        return null;
      }
      const { url, type } = server.transport;
      return { name: server.name, url, transport: type, oauth: server.oauth, headers: server.headers };
    },
    async save(serverId, oauth) {
      await db.update(servers).set({ oauth }).where(eq(servers.id, serverId));
      // The next read-modify-write loads straight after this, so it must see what was just saved.
      await snapshot.rebuild();
    },
  };
}
