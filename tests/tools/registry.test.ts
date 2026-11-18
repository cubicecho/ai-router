import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../server/core/errors.ts';
import { HttpStatus } from '../../server/core/wire.ts';
import { type Registry, RegistryClient, type RegistryFetch } from '../../server/tools/registry.ts';

const REGISTRY: Registry = { name: 'official', url: 'https://registry.modelcontextprotocol.io' };

/** A page as the official registry answers `GET /v0/servers`, trimmed. */
const LIST = {
  servers: [
    {
      server: {
        name: 'io.github.elis132/everything-mcp',
        description: 'Everything, as an MCP server',
        version: '1.0.4',
        repository: { url: 'https://github.com/elis132/everything-mcp', source: 'github' },
        packages: [
          {
            registryType: 'npm',
            identifier: 'everything-mcp',
            version: '1.0.4',
            transport: { type: 'stdio' },
            environmentVariables: [{ name: 'EVERYTHING_TOKEN', isSecret: true, format: 'string' }],
          },
        ],
      },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
    },
    {
      server: {
        name: 'com.example/hosted',
        version: '0.2.0',
        remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/mcp' }],
      },
    },
  ],
  metadata: { nextCursor: 'com.example/hosted:0.2.0', count: 2 },
};

/** One entry as the registry answers `GET /v0/servers/{name}/versions/latest`. */
const DETAIL = LIST.servers[0];

/**
 * A registry that answers every request with one body, and remembers the URLs it was asked.
 *
 * @param body - The JSON body.
 * @param [status] - The status.
 * @returns The client and the URLs.
 */
function registryAnswering(body: unknown, status: number = HttpStatus.Ok) {
  const asked: URL[] = [];
  const fetchImpl: RegistryFetch = async (url) => {
    asked.push(url);
    return Response.json(body, { status });
  };
  return { client: new RegistryClient(fetchImpl), asked };
}

describe('RegistryClient.listServers', () => {
  it('reads a page, asking for latest versions with the search, cursor and page size', async () => {
    const { client, asked } = registryAnswering(LIST);
    const page = await client.listServers(REGISTRY, { search: 'everything', limit: 5, cursor: 'abc' });
    const [url] = asked;
    expect(url?.pathname).toBe('/v0/servers');
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      version: 'latest',
      search: 'everything',
      limit: '5',
      cursor: 'abc',
    });
    expect(page.servers.map((entry) => entry.server.name)).toEqual([
      'io.github.elis132/everything-mcp',
      'com.example/hosted',
    ]);
    expect(page.metadata?.nextCursor).toBe('com.example/hosted:0.2.0');
  });

  it('sends no empty search, cursor or page size', async () => {
    const { client, asked } = registryAnswering(LIST);
    await client.listServers(REGISTRY, { search: '', limit: 0 });
    expect(asked[0]?.search).toBe('?version=latest');
  });

  it('keeps a registry URL path', async () => {
    const { client, asked } = registryAnswering(LIST);
    await client.listServers({ name: 'mirror', url: 'https://example.com/mcp-registry' });
    expect(asked[0]?.pathname).toBe('/mcp-registry/v0/servers');
  });

  it('accepts positional arguments that carry no name', async () => {
    const body = {
      servers: [
        {
          server: {
            name: 'com.pulsemcp/remote-filesystem',
            packages: [
              {
                registryType: 'npm',
                identifier: 'remote-filesystem-mcp-server',
                runtimeArguments: [{ value: '-y', type: 'positional' }],
              },
            ],
          },
        },
      ],
    };
    const { client } = registryAnswering(body);
    const page = await client.listServers(REGISTRY);
    expect(page.servers[0]?.server.packages?.[0]?.runtimeArguments?.[0]?.value).toBe('-y');
  });

  it('reads servers: null, an empty search, as no servers', async () => {
    const { client } = registryAnswering({ servers: null, metadata: { count: 0 } });
    expect((await client.listServers(REGISTRY)).servers).toEqual([]);
  });

  it('reports an unreachable registry', async () => {
    const client = new RegistryClient(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(client.listServers(REGISTRY)).rejects.toMatchObject({
      message: 'Registry "official" is unreachable: fetch failed',
      extensions: { code: ErrorCode.UpstreamFailed },
    });
  });

  it('gives up on a registry that does not answer in time', async () => {
    const neverAnswers: RegistryFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const client = new RegistryClient(neverAnswers, { fetchTimeoutMs: 10 });
    await expect(client.listServers(REGISTRY)).rejects.toMatchObject({
      message: 'Registry "official" did not answer within 10 ms.',
      extensions: { code: ErrorCode.UpstreamFailed },
    });
  });

  it('reports an answer in an unexpected shape', async () => {
    const { client } = registryAnswering({ nope: true });
    await expect(client.listServers(REGISTRY)).rejects.toThrow('unexpected shape');
  });

  it('reports a failed answer, with the start of its body', async () => {
    const { client } = registryAnswering({ error: 'boom' }, HttpStatus.ServiceUnavailable);
    await expect(client.listServers(REGISTRY)).rejects.toMatchObject({
      message: expect.stringContaining('HTTP 503: {"error":"boom"}'),
      extensions: { code: ErrorCode.UpstreamFailed },
    });
  });

  it('reports a 404 on the list as a failed answer, not a missing server', async () => {
    const { client } = registryAnswering({}, HttpStatus.NotFound);
    await expect(client.listServers(REGISTRY)).rejects.toMatchObject({
      extensions: { code: ErrorCode.UpstreamFailed },
    });
  });
});

describe('RegistryClient.getServer', () => {
  it('reads one entry, with its name URL-encoded', async () => {
    const { client, asked } = registryAnswering(DETAIL);
    const entry = await client.getServer(REGISTRY, 'io.github.elis132/everything-mcp');
    expect(asked[0]?.pathname).toBe('/v0/servers/io.github.elis132%2Feverything-mcp/versions/latest');
    expect(entry.server.packages?.[0]?.identifier).toBe('everything-mcp');
  });

  it('reports an entry the registry does not have as not found', async () => {
    const { client } = registryAnswering({ title: 'Not Found', status: 404 }, HttpStatus.NotFound);
    await expect(client.getServer(REGISTRY, 'nope/nope')).rejects.toMatchObject({
      message: 'Registry "official" has no server "nope/nope".',
      extensions: { code: ErrorCode.NotFound },
    });
  });
});
