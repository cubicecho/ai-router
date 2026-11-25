import { eq } from 'drizzle-orm';
import { errorMessage } from '../core/errors.ts';
import type { DB } from '../db/client.ts';
import { workers } from '../db/tables/workers.ts';
import type { ChannelMessage, LocalServer, WorkerHello } from '../runner/protocol.ts';

/** The router's end of a worker's channel. */
export interface WorkerChannel {
  /**
   * Sends the worker one message.
   *
   * @param message - What to say.
   */
  send(message: ChannelMessage): void;
  /** Closes the channel, for one a newer channel replaced. */
  close(): void;
}

/**
 * Hears a worker come online or go away.
 *
 * @param workerId - The worker.
 * @param online - Whether its channel is open now.
 */
export type PresenceListener = (workerId: string, online: boolean) => void;

/** The remote workers online now: each one's channel and what it said in its hello. Kept in memory only. */
export interface WorkerRegistry {
  /**
   * Makes a channel the worker's one channel, closing any older one.
   *
   * @param workerId - The worker.
   * @param channel - Its new channel.
   * @returns What to call when this channel closes. It does nothing once a newer channel has replaced it.
   */
  connect(workerId: string, channel: WorkerChannel): () => void;
  /**
   * Keeps what a worker said about itself, and records it on the worker's row.
   *
   * @param workerId - The worker.
   * @param hello - Its machine, version and local servers.
   */
  hello(workerId: string, hello: WorkerHello): Promise<void>;
  /**
   * Whether a worker's channel is open now.
   *
   * @param workerId - The worker.
   * @returns True while it is.
   */
  isOnline(workerId: string): boolean;
  /**
   * The servers a worker offers its runs, as its last hello said.
   *
   * @param workerId - The worker.
   * @returns Them, or none for a worker that is offline or hasn't said.
   */
  localServers(workerId: string): readonly LocalServer[];
  /**
   * The machine a worker said it runs on.
   *
   * @param workerId - The worker.
   * @returns Its host, or null for one that hasn't said.
   */
  host(workerId: string): string | null;
  /**
   * Sends a worker one message down its channel.
   *
   * @param workerId - The worker.
   * @param message - What to say.
   * @returns False when the worker is offline, so nothing was sent.
   */
  send(workerId: string, message: ChannelMessage): boolean;
  /**
   * Hears every worker come online and go away.
   *
   * @param listener - Told each change.
   * @returns What stops it hearing.
   */
  watch(listener: PresenceListener): () => void;
}

/**
 * Records when a worker was last seen, and what it said, on its row.
 *
 * @param db - The database.
 * @param workerId - The worker.
 * @param fields - Its host and version, when it said them.
 */
async function recordSeen(
  db: DB,
  workerId: string,
  fields: Partial<Pick<WorkerHello, 'host' | 'version'>>,
): Promise<void> {
  try {
    await db
      .update(workers)
      .set({ lastSeenAt: new Date(), ...fields })
      .where(eq(workers.id, workerId));
  } catch (error) {
    console.warn(`[workers] could not record that worker ${workerId} was seen: ${errorMessage(error)}`);
  }
}

/**
 * Builds the registry of online workers.
 *
 * @param db - The database, where each worker's last sighting, host and version are recorded.
 * @returns The registry, with no worker online.
 */
export function createWorkerRegistry(db: DB): WorkerRegistry {
  const channels = new Map<string, WorkerChannel>();
  const hellos = new Map<string, WorkerHello>();
  const listeners = new Set<PresenceListener>();
  const tell = (workerId: string, online: boolean): void => {
    for (const listener of listeners) {
      listener(workerId, online);
    }
  };

  return {
    connect(workerId, channel) {
      const older = channels.get(workerId);
      channels.set(workerId, channel);
      older?.close();
      tell(workerId, true);
      return () => {
        const isCurrent = channels.get(workerId) === channel;
        if (isCurrent) {
          channels.delete(workerId);
          tell(workerId, false);
          void recordSeen(db, workerId, {});
        }
      };
    },
    async hello(workerId, hello) {
      hellos.set(workerId, hello);
      await recordSeen(db, workerId, { host: hello.host, version: hello.version });
    },
    isOnline: (workerId) => channels.has(workerId),
    localServers: (workerId) => (channels.has(workerId) ? (hellos.get(workerId)?.servers ?? []) : []),
    host: (workerId) => hellos.get(workerId)?.host ?? null,
    send(workerId, message) {
      const channel = channels.get(workerId);
      if (channel === undefined) {
        return false;
      }
      channel.send(message);
      return true;
    },
    watch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
