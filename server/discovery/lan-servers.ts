import type { LanServer, ServerWatch, ServerWatchHandlers } from '@cubicecho/mcp-discovery/mdns';
import type { SnapshotServer } from '../db/snapshot.ts';
import { suggestServerName } from '../tools/installer.ts';
import { isHttpTransport } from '../tools/shapes.ts';

/** What a found server's local name falls back to when nothing valid can be made of its card's name. */
const FALLBACK_NAME = 'server';

/** The first number a taken name is suffixed with: `skills`, then `skills-2`. */
const FIRST_SUFFIX = 2;

/** A server found on the local network, offered to a person to add. Never added by the router itself. */
export interface LanServerSuggestion {
  /** Unique on the network: the host's mDNS name and the card's name. */
  key: string;
  /** The card's name, such as `io.github.cubicecho.mcp-skills.nas/skills`. */
  cardName: string;
  title: string | null;
  description: string;
  version: string;
  /** The host's mDNS instance name, such as `MCP Skills on nas`. */
  host: string;
  /** Its streamable-HTTP endpoint. */
  url: string;
  /** Headers the card says a client must send, such as `Authorization`. Their values are for a person to give. */
  requiredHeaders: string[];
  /** A name no server uses yet, made from the card's name. */
  suggestedName: string;
  /** The server already at its URL, or null when none is. */
  addedAs: string | null;
}

/** What the LAN watch needs from the router. */
export interface LanServersDeps {
  /** Whether to watch; read on every `sync`. */
  isWanted: () => boolean;
  /** The router's own mDNS instance name, so it never offers itself. */
  ownInstanceName: string;
  /** The router's servers, to tell which found servers are added and which names are taken. */
  servers: () => Iterable<Pick<SnapshotServer, 'name' | 'transport'>>;
  /** Writes a line to the log. */
  log: (message: string) => void;
  /** Starts the network watch: `watchServers` from `@cubicecho/mcp-discovery/mdns`, replaced in tests. */
  watch: (handlers: ServerWatchHandlers) => Promise<Pick<ServerWatch, 'stop'>>;
}

/** The servers found on the local network, as the router offers them. */
export interface LanServers {
  /** Whether a watch is running now. */
  isWatching: () => boolean;
  /** Starts or stops watching to match `isWanted()`. */
  sync: () => Promise<void>;
  /** Every found server it can offer, with what it is added as. */
  list: () => LanServerSuggestion[];
  /** Stops watching; call on shutdown. */
  close: () => Promise<void>;
}

/**
 * The same endpoint URL however it was written, so a server added by hand matches the one found.
 *
 * @param url - A URL.
 * @returns It without a trailing slash, or as given when it does not parse.
 */
function sameUrl(url: string): string {
  if (URL.canParse(url) === false) {
    return url;
  }
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

/**
 * A local name for a found server that no server uses yet.
 *
 * @param cardName - The card's name.
 * @param taken - The names in use.
 * @returns Such as `skills`, or `skills-2` when `skills` is taken.
 */
function freeName(cardName: string, taken: ReadonlySet<string>): string {
  const base = suggestServerName(cardName) ?? FALLBACK_NAME;
  let candidate = base;
  for (let suffix = FIRST_SUFFIX; taken.has(candidate); suffix++) {
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

/**
 * Builds the LAN watch; nothing is watched until the first `sync`.
 *
 * @param deps - The switch, the router's own name, its servers, and the network watch.
 * @returns The watch.
 *
 * @remarks
 * Cards are unauthenticated and anything on the LAN can advertise, so a found server is only ever a suggestion: a
 * person adds it with `installServer`, and gives any header it needs. The router's own card, and one with no
 * streamable-HTTP URL it can use as it stands, are left out.
 */
export function createLanServers(deps: LanServersDeps): LanServers {
  const found = new Map<string, LanServer>();
  let watch: Pick<ServerWatch, 'stop'> | null = null;
  let queue: Promise<void> = Promise.resolve();

  const isOffered = (server: LanServer): boolean => {
    const isSelf = server.host.name === deps.ownInstanceName;
    return isSelf === false && server.connection !== null;
  };

  const handlers: ServerWatchHandlers = {
    onUp: (server) => {
      if (isOffered(server)) {
        found.set(server.key, server);
      }
    },
    onDown: (server) => {
      found.delete(server.key);
    },
    onError: (error) => deps.log(`[discovery] ${error.message}`),
  };

  const stop = async (): Promise<void> => {
    if (watch === null) {
      return;
    }
    const stopping = watch;
    watch = null;
    found.clear();
    await stopping.stop();
  };

  const apply = async (): Promise<void> => {
    const isWanted = deps.isWanted();
    if (isWanted && watch === null) {
      try {
        watch = await deps.watch(handlers);
        deps.log('[discovery] watching the local network for MCP servers');
      } catch (error) {
        deps.log(`[discovery] could not watch the local network: ${String(error)}`);
      }
      return;
    }
    if (isWanted === false && watch !== null) {
      await stop();
      deps.log('[discovery] stopped watching the local network');
    }
  };

  // One after another, so a quick on-off-on never runs two watches.
  const enqueue = (step: () => Promise<void>): Promise<void> => {
    queue = queue.then(step, step);
    return queue;
  };

  return {
    isWatching: () => watch !== null,
    sync: () => enqueue(apply),
    close: () => enqueue(stop),
    list: () => {
      const servers = [...deps.servers()];
      const taken = new Set(servers.map((server) => server.name));
      return [...found.values()].flatMap((server): LanServerSuggestion[] => {
        const { connection, card } = server;
        if (connection === null) {
          return [];
        }
        const added = servers.find(
          (candidate) =>
            isHttpTransport(candidate.transport) && sameUrl(candidate.transport.url) === sameUrl(connection.url),
        );
        return [
          {
            key: server.key,
            cardName: card.name,
            title: card.title ?? null,
            description: card.description,
            version: card.version,
            host: server.host.name,
            url: connection.url,
            requiredHeaders: connection.requiredHeaders,
            suggestedName: freeName(card.name, taken),
            addedAs: added?.name ?? null,
          },
        ];
      });
    },
  };
}

/**
 * A LAN watch that never watches, for an app built without one (tests, tools).
 *
 * @returns One whose list is always empty.
 */
export function idleLanServers(): LanServers {
  return { isWatching: () => false, sync: async () => undefined, list: () => [], close: async () => undefined };
}
