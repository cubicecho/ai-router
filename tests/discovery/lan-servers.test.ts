import { cardConnection, createServerCard, type ServerCard } from '@cubicecho/mcp-discovery';
import { type LanServer, type ServerWatchHandlers, toMcpHost } from '@cubicecho/mcp-discovery/mdns';
import { describe, expect, it, vi } from 'vitest';
import type { SnapshotServer } from '../../server/db/snapshot.ts';
import { createLanServers, idleLanServers } from '../../server/discovery/lan-servers.ts';
import { TRANSPORT_STDIO, TRANSPORT_STREAMABLE_HTTP } from '../../server/tools/shapes.ts';

/** The router's own mDNS name in these tests. */
const OWN_NAME = 'AI Router on box';

/** A router server, as the list compares found servers with. */
type KnownServer = Pick<SnapshotServer, 'name' | 'transport'>;

/**
 * A server another host advertises, as `watchServers` reports it.
 *
 * @param instance - The host's mDNS name.
 * @param card - The card's fields to set.
 * @param remotes - Its remotes.
 * @returns The found server.
 */
function lanServer(
  instance: string,
  card: Partial<ServerCard> & { name: string },
  remotes: ServerCard['remotes'] = [],
): LanServer {
  const full = createServerCard({ version: '1.0.0', description: 'Something useful.', remotes, ...card });
  const host = toMcpHost({ name: instance, host: 'nas.local', port: 3000, addresses: ['192.168.1.20'], txt: {} });
  return { key: `${instance}/${full.name}`, host, card: full, cardUrl: null, connection: cardConnection(full) };
}

/** A LAN watch over a fake network, with the switch and the router's servers under the test's control. */
function setup() {
  const state = { wanted: true, servers: [] as KnownServer[] };
  let handlers: ServerWatchHandlers | undefined;
  const stop = vi.fn(async () => undefined);
  const watch = vi.fn(async (given: ServerWatchHandlers) => {
    handlers = given;
    return { stop };
  });
  const log = vi.fn();
  const lan = createLanServers({
    isWanted: () => state.wanted,
    ownInstanceName: OWN_NAME,
    servers: () => state.servers,
    log,
    watch,
  });
  const announce = (server: LanServer) => handlers?.onUp(server);
  const leave = (server: LanServer) => handlers?.onDown?.(server);
  return { lan, state, watch, stop, log, announce, leave };
}

const SKILLS_URL = 'http://192.168.1.20:3000/mcp';

const skills = lanServer('MCP Skills on nas', { name: 'io.github.cubicecho.mcp-skills.nas/skills', title: 'Skills' }, [
  {
    type: TRANSPORT_STREAMABLE_HTTP,
    url: SKILLS_URL,
    headers: [{ name: 'Authorization', isRequired: true, isSecret: true }],
  },
]);

describe('createLanServers', () => {
  it('offers a found server with a free name and the headers a person must give', async () => {
    const { lan, announce } = setup();
    await lan.sync();
    announce(skills);
    expect(lan.list()).toEqual([
      {
        key: skills.key,
        cardName: 'io.github.cubicecho.mcp-skills.nas/skills',
        title: 'Skills',
        description: 'Something useful.',
        version: '1.0.0',
        host: 'MCP Skills on nas',
        url: SKILLS_URL,
        requiredHeaders: ['Authorization'],
        suggestedName: 'skills',
        addedAs: null,
      },
    ]);
  });

  it('never offers its own card, or one with no URL it can use as it stands', async () => {
    const { lan, announce } = setup();
    await lan.sync();
    announce(
      lanServer(OWN_NAME, { name: 'io.github.cubicecho.ai-router.box/agents' }, [
        { type: TRANSPORT_STREAMABLE_HTTP, url: 'http://10.0.0.1/mcp' },
      ]),
    );
    announce(
      lanServer('Templated on nas', { name: 'com.example/templated' }, [
        { type: TRANSPORT_STREAMABLE_HTTP, url: 'http://{host}/mcp' },
      ]),
    );
    expect(lan.list()).toEqual([]);
  });

  it('says which server is already at its URL, however the URL was written', async () => {
    const { lan, state, announce } = setup();
    await lan.sync();
    announce(skills);
    state.servers = [{ name: 'my-skills', transport: { type: TRANSPORT_STREAMABLE_HTTP, url: `${SKILLS_URL}/` } }];
    expect(lan.list()[0]).toMatchObject({ addedAs: 'my-skills' });
  });

  it('suggests a name no server has taken', async () => {
    const { lan, state, announce } = setup();
    await lan.sync();
    announce(skills);
    state.servers = [
      { name: 'skills', transport: { type: TRANSPORT_STDIO, command: 'node', args: [] } },
      { name: 'skills-2', transport: { type: TRANSPORT_STDIO, command: 'node', args: [] } },
    ];
    expect(lan.list()[0]).toMatchObject({ suggestedName: 'skills-3', addedAs: null });
  });

  it('drops a server that leaves', async () => {
    const { lan, announce, leave } = setup();
    await lan.sync();
    announce(skills);
    leave(skills);
    expect(lan.list()).toEqual([]);
  });

  it('watches only while wanted, and forgets what it found when it stops', async () => {
    const { lan, state, watch, stop, announce } = setup();
    state.wanted = false;
    await lan.sync();
    expect(watch).not.toHaveBeenCalled();
    expect(lan.isWatching()).toBe(false);

    state.wanted = true;
    await Promise.all([lan.sync(), lan.sync()]);
    expect(watch).toHaveBeenCalledOnce();
    expect(lan.isWatching()).toBe(true);
    announce(skills);

    state.wanted = false;
    await lan.sync();
    expect(stop).toHaveBeenCalledOnce();
    expect(lan.list()).toEqual([]);
  });

  it('logs a watch that cannot start, and carries on', async () => {
    const log = vi.fn();
    const lan = createLanServers({
      isWanted: () => true,
      ownInstanceName: OWN_NAME,
      servers: () => [],
      log,
      watch: async () => {
        throw new Error('multicast is blocked');
      },
    });
    await lan.sync();
    expect(lan.isWatching()).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('multicast is blocked'));
  });

  it('stops on close', async () => {
    const { lan, stop } = setup();
    await lan.sync();
    await lan.close();
    expect(stop).toHaveBeenCalledOnce();
    expect(lan.isWatching()).toBe(false);
  });
});

describe('idleLanServers', () => {
  it('finds nothing and never watches', async () => {
    const lan = idleLanServers();
    await lan.sync();
    expect(lan.isWatching()).toBe(false);
    expect(lan.list()).toEqual([]);
  });
});
