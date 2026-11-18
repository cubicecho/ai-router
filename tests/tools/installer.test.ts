import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CHILD_DEFAULTS, INSTALL_DEFAULTS } from '../../server/core/defaults.ts';
import { ErrorCode } from '../../server/core/errors.ts';
import { MS_PER_SECOND } from '../../server/core/wire.ts';
import { type ChildIsolation, ChildMode } from '../../server/tools/child-users.ts';
import { type ChildExec, childEnv } from '../../server/tools/install-folder.ts';
import {
  buildPypiTransport,
  deriveServerName,
  envFromRegistry,
  fixedArgsFrom,
  type InstallDeps,
  installServer,
  resolveBinEntry,
  selectFromEntry,
} from '../../server/tools/installer.ts';
import { type Registry, RegistryClient, type RegistryServerEntry } from '../../server/tools/registry.ts';

const HELPER = '/usr/local/bin/run-as-child';
const UID = CHILD_DEFAULTS.uidMin;
const INSTALL_DIR = `/data/servers/${UID}-0123456789abcdef`;
const ISOLATED: ChildIsolation = { mode: ChildMode.Isolated, reason: '' };
const REFUSED: ChildIsolation = { mode: ChildMode.Refused, reason: 'the helper cannot switch users' };
const OFFICIAL: Registry = { name: 'official', url: 'https://registry.example' };

/** One command as the helper was asked to run it, without the helper, uid and `timeout` in front. */
interface Call {
  command: string;
  args: string[];
  env: Record<string, string>;
  helper: string;
  uid: string;
}

let calls: Call[];

/**
 * A stand-in for the helper and npm: `npm install` "installs" a package.json, `cat` reads it back.
 *
 * @param packageJson - What the installed package.json holds, or a string for a body that isn't JSON.
 * @param [fail] - Thrown by `npm install` instead.
 * @returns The exec.
 */
function fakeNpm(packageJson: Record<string, unknown> | string, fail?: unknown): ChildExec {
  return async (helper, args, options) => {
    const [uid = '', , , , command = '', ...rest] = args;
    calls.push({ command, args: rest, env: options.env, helper, uid });
    if (command === 'npm' && fail !== undefined) {
      throw fail;
    }
    if (command === 'cat') {
      return { stdout: typeof packageJson === 'string' ? packageJson : JSON.stringify(packageJson), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
}

/**
 * A registry that answers every entry request with one entry.
 *
 * @param entry - The entry.
 * @returns A client over it.
 */
function registryOf(entry: RegistryServerEntry): RegistryClient {
  return new RegistryClient(async () => Response.json(entry));
}

/**
 * The deps of an isolated install.
 *
 * @param overrides - What differs.
 * @returns The deps.
 */
function deps(overrides: Partial<InstallDeps> = {}): InstallDeps {
  return {
    isolation: ISOLATED,
    childUid: UID,
    installDir: INSTALL_DIR,
    helperPath: HELPER,
    getRegistry: (name) => (name === OFFICIAL.name ? OFFICIAL : undefined),
    exec: fakeNpm({ bin: 'cli.js' }),
    ...overrides,
  };
}

beforeEach(() => {
  calls = [];
});

describe('resolveBinEntry', () => {
  it('uses a string bin as it is', () => {
    expect(resolveBinEntry('@scope/pkg', 'dist/cli.js')).toBe('dist/cli.js');
  });

  it('prefers the entry named after the package, else the first', () => {
    expect(resolveBinEntry('@scope/my-tool', { other: 'a.js', 'my-tool': 'b.js' })).toBe('b.js');
    expect(resolveBinEntry('pkg', { alpha: 'a.js', beta: 'b.js' })).toBe('a.js');
  });

  it('refuses a package with no program', () => {
    expect(() => resolveBinEntry('pkg', undefined)).toThrow(/no "bin" entry/);
    expect(() => resolveBinEntry('pkg', {})).toThrow(/no "bin" entry/);
  });
});

describe('deriveServerName', () => {
  it('takes the last part of a package or entry name', () => {
    expect(deriveServerName({ type: 'npm', package: '@modelcontextprotocol/server-everything' })).toBe(
      'server-everything',
    );
    expect(deriveServerName({ type: 'registry', registry: 'official', serverName: 'io.github.owner/My_Repo' })).toBe(
      'my_repo',
    );
  });

  it('refuses when nothing valid is left, or there is nothing to derive from', () => {
    expect(() => deriveServerName({ type: 'pypi', package: '///' })).toThrow();
    expect(() => deriveServerName({ type: 'manual' })).toThrow(/needs a name/);
  });
});

describe('fixedArgsFrom', () => {
  it('collects positional values and named flags with their values', () => {
    expect(
      fixedArgsFrom([
        { name: 'path', type: 'positional', value: '/srv' },
        { name: '--flag', type: 'named' },
        { name: '--port', type: 'named', value: '8080' },
        { name: 'optional-no-value', type: 'positional' },
        { type: 'positional', default: 'x' },
      ]),
    ).toEqual(['/srv', '--flag', '--port', '8080', 'x']);
  });
});

describe('envFromRegistry', () => {
  it('prefills values and defaults, and describes every variable', () => {
    const { env, envMeta } = envFromRegistry([
      { name: 'API_KEY', description: 'key', isRequired: true, isSecret: true },
      { name: 'REGION', default: 'us-east-1', choices: ['us-east-1', 'eu-west-1'] },
      { name: 'FIXED', value: 'always' },
    ]);
    expect(env).toEqual({ REGION: 'us-east-1', FIXED: 'always' });
    expect(envMeta.API_KEY).toMatchObject({ description: 'key', isRequired: true, isSecret: true });
    expect(envMeta.REGION?.choices).toEqual(['us-east-1', 'eu-west-1']);
  });
});

describe('buildPypiTransport', () => {
  it('runs the package with uvx, pinned with @version', () => {
    expect(buildPypiTransport('mcp-server-fetch', undefined, ['--foo'])).toEqual({
      type: 'stdio',
      command: 'uvx',
      args: ['mcp-server-fetch', '--foo'],
    });
    expect(buildPypiTransport('mcp-server-time', '1.4.0')).toMatchObject({ args: ['mcp-server-time@1.4.0'] });
  });

  it('refuses a name that could be read as a flag', () => {
    expect(() => buildPypiTransport('--with=evil', undefined)).toThrow(/not a PyPI package name/);
  });
});

describe('selectFromEntry', () => {
  const entry: RegistryServerEntry = {
    server: {
      name: 'io.github.owner/thing',
      packages: [
        { registryType: 'pypi', identifier: 'thing-py' },
        { registryType: 'npm', identifier: 'thing-js' },
      ],
      remotes: [{ type: 'streamable-http', url: 'https://example.com/mcp' }],
    },
  };

  it('picks the first npm package, else PyPI, else a remote', () => {
    expect(selectFromEntry(entry, undefined)).toEqual({ package: entry.server.packages?.[1] });
    const pypiOnly = { server: { name: 'x', packages: [{ registryType: 'pypi', identifier: 'p' }] } };
    expect(selectFromEntry(pypiOnly, undefined)).toEqual({ package: pypiOnly.server.packages[0] });
    const remoteOnly = { server: { name: 'x', remotes: entry.server.remotes } };
    expect(selectFromEntry(remoteOnly, undefined)).toEqual({ remote: entry.server.remotes?.[0] });
  });

  it('follows a package or remote selector', () => {
    expect(selectFromEntry(entry, '0')).toEqual({ package: entry.server.packages?.[0] });
    expect(selectFromEntry(entry, 'remote:0')).toEqual({ remote: entry.server.remotes?.[0] });
  });

  it('refuses a selector that matches nothing or is malformed', () => {
    expect(() => selectFromEntry(entry, '9')).toThrow();
    expect(() => selectFromEntry(entry, 'remote:9')).toThrow();
    expect(() => selectFromEntry(entry, 'bogus')).toThrow();
  });
});

describe('installServer', () => {
  it('installs an npm package as the server user, into its folder, and reads back its program', async () => {
    const result = await installServer(
      { source: { type: 'npm', package: '@scope/echo-server', version: '1.2.3' } },
      deps({ exec: fakeNpm({ bin: { 'echo-server': 'dist/cli.js' } }) }),
    );
    const packageDir = path.join(INSTALL_DIR, 'node_modules', '@scope', 'echo-server');
    expect(calls.map(({ command, args }) => [command, ...args])).toEqual([
      ['npm', 'install', '--prefix', INSTALL_DIR, '@scope/echo-server@1.2.3', '--no-audit', '--no-fund'],
      ['cat', path.join(packageDir, 'package.json')],
    ]);
    expect(calls.every((call) => call.helper === HELPER && call.uid === String(UID))).toBe(true);
    expect(calls.every((call) => JSON.stringify(call.env) === JSON.stringify(childEnv(INSTALL_DIR)))).toBe(true);
    expect(result).toEqual({
      source: { type: 'npm', package: '@scope/echo-server', version: '1.2.3' },
      transport: { type: 'stdio', command: 'node', args: [path.join(packageDir, 'dist', 'cli.js')] },
      headers: {},
      env: {},
      envMeta: {},
    });
  });

  it('installs the latest version when none is named', async () => {
    await installServer({ source: { type: 'npm', package: 'tool' } }, deps());
    expect(calls[0]?.args).toContain('tool@latest');
  });

  it('gives npm install its time limit, enforced as the child', async () => {
    const exec: ChildExec = async (helper, args, options) => {
      calls.push({ command: args[1] ?? '', args, env: options.env, helper, uid: args[0] ?? '' });
      return { stdout: JSON.stringify({ bin: 'cli.js' }), stderr: '' };
    };
    await installServer({ source: { type: 'npm', package: 'tool' } }, deps({ exec }));
    expect(calls[0]?.args.slice(1, 4)).toEqual([
      'timeout',
      `--kill-after=${INSTALL_DEFAULTS.killGraceMs / MS_PER_SECOND}s`,
      `${INSTALL_DEFAULTS.npmTimeoutMs / MS_PER_SECOND}s`,
    ]);
  });

  it('installs a registry npm package with its fixed arguments, env prefills and hints', async () => {
    const registryClient = registryOf({
      server: {
        name: 'io.github.owner/widget',
        title: 'Widget',
        description: 'A widget server',
        packages: [
          {
            registryType: 'npm',
            identifier: 'widget-mcp',
            version: '2.0.0',
            packageArguments: [{ name: 'mode', type: 'positional', value: 'serve' }],
            environmentVariables: [
              { name: 'WIDGET_KEY', isRequired: true, isSecret: true },
              { name: 'WIDGET_REGION', default: 'eu' },
            ],
          },
        ],
      },
    });
    const result = await installServer(
      { source: { type: 'registry', registry: 'official', serverName: 'io.github.owner/widget' } },
      deps({ registryClient, exec: fakeNpm({ bin: { 'widget-mcp': 'bin/run.js' } }) }),
    );
    expect(calls[0]?.args).toContain('widget-mcp@2.0.0');
    expect(result).toMatchObject({ displayName: 'Widget', description: 'A widget server', headers: {} });
    expect(result.transport.type === 'stdio' && result.transport.args.at(-1)).toBe('serve');
    expect(result.env).toEqual({ WIDGET_REGION: 'eu' });
    expect(result.envMeta.WIDGET_KEY).toMatchObject({ isRequired: true, isSecret: true });
  });

  it('turns a PyPI package into a uvx command and installs nothing', async () => {
    const result = await installServer(
      { source: { type: 'pypi', package: 'mcp-server-fetch', version: '1.2.3' } },
      deps(),
    );
    expect(calls).toEqual([]);
    expect(result.transport).toEqual({ type: 'stdio', command: 'uvx', args: ['mcp-server-fetch@1.2.3'] });
  });

  it('turns a registry PyPI package into a uvx command with its arguments', async () => {
    const registryClient = registryOf({
      server: {
        name: 'io.github.owner/pywidget',
        packages: [
          {
            registryType: 'pypi',
            identifier: 'pywidget-mcp',
            version: '3.1.0',
            packageArguments: [{ type: 'positional', value: 'serve' }],
          },
        ],
      },
    });
    const result = await installServer(
      { source: { type: 'registry', registry: 'official', serverName: 'io.github.owner/pywidget' } },
      deps({ registryClient }),
    );
    expect(calls).toEqual([]);
    expect(result.transport).toEqual({ type: 'stdio', command: 'uvx', args: ['pywidget-mcp@3.1.0', 'serve'] });
  });

  it('keeps a registry remote header values apart from its transport', async () => {
    const registryClient = registryOf({
      server: {
        name: 'io.github.owner/hosted',
        remotes: [
          {
            type: 'streamable-http',
            url: 'https://mcp.example.com/mcp',
            headers: [
              { name: 'X-Fixed', value: 'yes' },
              { name: 'Authorization', isSecret: true },
            ],
          },
        ],
      },
    });
    const result = await installServer(
      { source: { type: 'registry', registry: 'official', serverName: 'io.github.owner/hosted' } },
      deps({ registryClient }),
    );
    expect(calls).toEqual([]);
    expect(result.transport).toEqual({ type: 'streamable-http', url: 'https://mcp.example.com/mcp' });
    expect(result.headers).toEqual({ 'X-Fixed': 'yes' });
  });

  it('refuses a remote that is not streamable HTTP', async () => {
    const registryClient = registryOf({
      server: { name: 'x/sse', remotes: [{ type: 'sse', url: 'https://mcp.example.com/sse' }] },
    });
    await expect(
      installServer(
        { source: { type: 'registry', registry: 'official', serverName: 'x/sse' } },
        deps({ registryClient }),
      ),
    ).rejects.toMatchObject({ extensions: { code: ErrorCode.BadUserInput } });
  });

  it('refuses an unknown registry', async () => {
    await expect(
      installServer({ source: { type: 'registry', registry: 'nope', serverName: 'x/y' } }, deps()),
    ).rejects.toMatchObject({ extensions: { code: ErrorCode.NotFound } });
  });

  it('takes a manual server transport as given, and needs one', async () => {
    const transport = { type: 'streamable-http' as const, url: 'https://r.example/mcp' };
    const result = await installServer({ source: { type: 'manual' }, transport }, deps());
    expect(result).toEqual({ source: { type: 'manual' }, transport, headers: {}, env: {}, envMeta: {} });
    await expect(installServer({ source: { type: 'manual' } }, deps())).rejects.toThrow(/command or an address/);
  });

  it('reports a failed npm install with the end of its stderr', async () => {
    const fail = Object.assign(new Error('Command failed'), { code: 1, stderr: 'npm ERR! 404 Not Found' });
    await expect(
      installServer({ source: { type: 'npm', package: 'missing-pkg' } }, deps({ exec: fakeNpm({}, fail) })),
    ).rejects.toMatchObject({
      message: expect.stringContaining('404 Not Found'),
      extensions: { code: ErrorCode.UpstreamFailed },
    });
  });

  it('reports an npm install that timeout stopped', async () => {
    const fail = Object.assign(new Error('Command failed'), { code: 124, stderr: '' });
    await expect(
      installServer({ source: { type: 'npm', package: 'slow-pkg' } }, deps({ exec: fakeNpm({}, fail) })),
    ).rejects.toThrow(`did not finish within ${INSTALL_DEFAULTS.npmTimeoutMs} ms`);
  });

  it('reports an installed package.json that is not JSON', async () => {
    await expect(
      installServer({ source: { type: 'npm', package: 'tool' } }, deps({ exec: fakeNpm('not json') })),
    ).rejects.toMatchObject({ extensions: { code: ErrorCode.UpstreamFailed } });
  });

  it('refuses a package name or version that could be read as a flag, before running anything', async () => {
    await expect(installServer({ source: { type: 'npm', package: '--prefix=/' } }, deps())).rejects.toThrow(
      /not an npm package name/,
    );
    await expect(
      installServer({ source: { type: 'npm', package: 'tool', version: '--global' } }, deps()),
    ).rejects.toThrow(/not a version/);
    expect(calls).toEqual([]);
  });

  it('refuses to install when child processes are refused', async () => {
    await expect(
      installServer({ source: { type: 'npm', package: 'tool' } }, deps({ isolation: REFUSED })),
    ).rejects.toMatchObject({ message: REFUSED.reason, extensions: { code: ErrorCode.Conflict } });
    expect(calls).toEqual([]);
  });
});
