import path from 'node:path';
import { z } from 'zod';
import { INSTALL_DEFAULTS, type InstallSettings, NAME_DEFAULTS } from '../core/defaults.ts';
import { badInput, notFound, upstreamFailed } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import { type ChildIsolation, serverChildUser } from './child-users.ts';
import { ChildCommandError, type ChildExec, homeOf, runAsServer, type ServerUser } from './install-folder.ts';
import {
  type Registry,
  type RegistryArgument,
  RegistryClient,
  type RegistryKeyValueInput,
  type RegistryPackage,
  type RegistryRemote,
  type RegistryServerEntry,
} from './registry.ts';
import {
  type EnvVarMeta,
  HTTP_TRANSPORTS,
  httpTransportType,
  type InstallSource,
  type ServerTransport,
  SourceType,
  serverNameSchema,
  TRANSPORT_STDIO,
} from './shapes.ts';

/**
 * Turns an install request into what a server is stored with. Ported from mcp-router's
 * `server/src/installer/installer.ts`.
 *
 * An npm package is installed by the server's own user into its own folder, install scripts and
 * all: that is the point of running it as that user. A PyPI package has no install step: `uvx` fetches
 * it at start, as the server's user, with its caches in the server's folder. Nothing is saved here.
 */

/** A registry package type the installer can install. */
const REGISTRY_TYPE_NPM = 'npm';
/** The other one. */
const REGISTRY_TYPE_PYPI = 'pypi';
/** A registry argument passed as its name, then its value. */
const ARGUMENT_NAMED = 'named';
/** The version npm installs when none is named. */
const NPM_LATEST = 'latest';
/** A package selector that picks a remote: `remote:<index>`. */
const REMOTE_SELECTOR = /^remote:(\d+)$/;
/** A package selector that picks a package: `<index>`. */
const PACKAGE_SELECTOR = /^\d+$/;
/** An npm package name, scope included. */
const NPM_NAME = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
/** A PyPI distribution name, with optional extras. */
const PYPI_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9._,-]+\])?$/;
/** A version or tag: anything without spaces that can't be read as a flag. */
const VERSION = /^[^\s-]\S*$/;

/** What to install. */
export interface InstallRequest {
  source: InstallSource;
  /** For a registry source: `<index>` into the entry's packages, or `remote:<index>`. The first npm package, else PyPI, else remote, when absent. */
  packageSelector?: string;
  /** For a manual source: the command or address, as given. */
  transport?: ServerTransport;
}

/** What an install needs from the rest of the router. */
export interface InstallDeps {
  isolation: ChildIsolation;
  /** The server's uid. */
  childUid: number;
  /** The server's folder, from `createInstallFolder`, as an absolute path. */
  installDir: string;
  /** Finds a registry by name; undefined when there is none. */
  getRegistry: (name: string) => Registry | undefined | Promise<Registry | undefined>;
  /** Reads the registry; a default client when absent. */
  registryClient?: RegistryClient;
  /** Runs commands as the server's user; `execChild` when absent. */
  exec?: ChildExec;
  /** The helper's path; `runAsChildPath()` when absent. */
  helperPath?: string;
  /** Settings that differ from `INSTALL_DEFAULTS`. */
  overrides?: Partial<InstallSettings>;
}

/** What an install decided: the parts of a server to store. */
export interface InstallResult {
  source: InstallSource;
  /** How to start or reach it. A remote's header values are in `headers`, not here. */
  transport: ServerTransport;
  /** Header values a registry remote declares, to keep as secrets. Empty for anything else. */
  headers: Record<string, string>;
  /** Env values the registry entry declares, as prefills under the caller's own. */
  env: Record<string, string>;
  /** What the UI shows for each env var the entry declares. */
  envMeta: Record<string, EnvVarMeta>;
  displayName?: string;
  description?: string;
}

/**
 * Suggests a server name from a package or registry entry name.
 *
 * @param source - Where the server comes from.
 * @returns The last path segment, lower-cased, with each run of other characters as one dash.
 * @throws BAD_USER_INPUT for a manual source, or when nothing valid is left.
 */
export function deriveServerName(source: InstallSource): string {
  if (source.type === SourceType.Manual) {
    throw badInput('A server added by hand needs a name.');
  }
  const raw = source.type === SourceType.Registry ? source.serverName : source.package;
  const lastSegment = raw.split('/').pop() ?? raw;
  const suggested = lastSegment
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, NAME_DEFAULTS.maxLength);
  const result = serverNameSchema.safeParse(suggested);
  if (result.success === false) {
    throw badInput(`No server name can be made from "${raw}". Give one.`);
  }
  return result.data;
}

/**
 * Picks the program an installed package.json names.
 *
 * @param packageName - The package, scope included. Its last part picks among several bins.
 * @param bin - The `bin` field as read: a string is used as it is; of an object, the matching entry or the first.
 * @returns The bin's path, relative to the package.
 * @throws BAD_USER_INPUT when there is no usable entry, so the package can't run over stdio.
 */
export function resolveBinEntry(packageName: string, bin: unknown): string {
  if (typeof bin === 'string' && bin !== '') {
    return bin;
  }
  if (isRecord(bin)) {
    const entries = Object.entries(bin).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    const basename = packageName.split('/').pop() ?? packageName;
    const match = entries.find(([key]) => key === basename) ?? entries[0];
    if (match !== undefined) {
      return match[1];
    }
  }
  throw badInput(`Package "${packageName}" has no "bin" entry, so there is no program to start.`);
}

/**
 * Collects a registry package's fixed arguments as command-line arguments.
 *
 * @param args - The package's arguments; undefined reads as none.
 * @returns A named argument as its name then its value (the name alone without one), a positional one as
 * its value. A positional one without a value is left out.
 */
export function fixedArgsFrom(args: RegistryArgument[] | undefined): string[] {
  const result: string[] = [];
  for (const arg of args ?? []) {
    const value = arg.value ?? arg.default ?? '';
    const name = arg.name ?? '';
    if (arg.type === ARGUMENT_NAMED) {
      if (name !== '') {
        result.push(name);
        if (value !== '') {
          result.push(value);
        }
      }
    } else if (value !== '') {
      result.push(value);
    }
  }
  return result;
}

/**
 * Maps a registry package's env vars to prefills and UI hints.
 *
 * @param vars - The declared variables; undefined reads as none.
 * @returns `env` with the variables that carry a value or a default, and `envMeta` with a hint for every one.
 */
export function envFromRegistry(vars: RegistryKeyValueInput[] | undefined): {
  env: Record<string, string>;
  envMeta: Record<string, EnvVarMeta>;
} {
  const env: Record<string, string> = {};
  const envMeta: Record<string, EnvVarMeta> = {};
  for (const variable of vars ?? []) {
    envMeta[variable.name] = {
      description: variable.description,
      isRequired: variable.isRequired,
      isSecret: variable.isSecret,
      default: variable.default,
      placeholder: variable.placeholder,
      choices: variable.choices ?? undefined,
    };
    const value = variable.value ?? variable.default;
    if (value !== undefined) {
      env[variable.name] = value;
    }
  }
  return { env, envMeta };
}

/**
 * Collects the header values a registry remote declares.
 *
 * @param headers - The declared headers; undefined reads as none.
 * @returns The headers that carry a value or a default.
 */
function headersFromRegistry(headers: RegistryKeyValueInput[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of headers ?? []) {
    const value = header.value ?? header.default;
    if (value !== undefined) {
      result[header.name] = value;
    }
  }
  return result;
}

/**
 * Picks the package or remote to install from a registry entry.
 *
 * @param entry - The entry.
 * @param selector - `<index>` into its packages or `remote:<index>`. When undefined: the first npm package,
 * else the first PyPI one, else the first streamable-HTTP remote, else the first SSE one, else the first remote.
 * @returns The chosen package or remote.
 * @throws BAD_USER_INPUT for a malformed selector, one that matches nothing, or an entry with nothing to install.
 */
export function selectFromEntry(
  entry: RegistryServerEntry,
  selector: string | undefined,
): { package: RegistryPackage } | { remote: RegistryRemote } {
  const packages = entry.server.packages ?? [];
  const remotes = entry.server.remotes ?? [];
  if (selector !== undefined) {
    const remoteMatch = REMOTE_SELECTOR.exec(selector);
    if (remoteMatch !== null) {
      const remote = remotes[Number(remoteMatch[1])];
      if (remote === undefined) {
        throw badInput(`"${selector}" matches none of the entry's remotes.`);
      }
      return { remote };
    }
    const isIndex = PACKAGE_SELECTOR.test(selector);
    if (isIndex === false) {
      throw badInput(`"${selector}" is not a package selector. Use "<index>" or "remote:<index>".`);
    }
    const chosen = packages[Number(selector)];
    if (chosen === undefined) {
      throw badInput(`"${selector}" matches none of the entry's packages.`);
    }
    return { package: chosen };
  }
  const supported =
    packages.find((candidate) => candidate.registryType === REGISTRY_TYPE_NPM) ??
    packages.find((candidate) => candidate.registryType === REGISTRY_TYPE_PYPI);
  if (supported !== undefined) {
    return { package: supported };
  }
  const reachable = HTTP_TRANSPORTS.map((type) => remotes.find((candidate) => candidate.type === type)).find(
    (candidate) => candidate !== undefined,
  );
  const remote = reachable ?? remotes[0];
  if (remote !== undefined) {
    return { remote };
  }
  throw badInput('The registry entry has no npm or PyPI package and no remote to install.');
}

/**
 * Refuses a version that could be read as a flag or split into two arguments.
 *
 * @param version - The version or tag; undefined passes.
 * @throws BAD_USER_INPUT for anything else.
 */
function assertVersion(version: string | undefined): void {
  const isUsable = version === undefined || VERSION.test(version);
  if (isUsable === false) {
    throw badInput(`"${version}" is not a version.`);
  }
}

/**
 * Builds the transport that runs a PyPI package with `uvx`.
 *
 * @param packageName - The distribution, which is also its program's name: the MCP registry's convention.
 * @param version - Pinned with uv's `<name>@<version>`; undefined or empty leaves it unpinned.
 * @param [extraArgs] - Passed after the package.
 * @returns The transport.
 * @throws BAD_USER_INPUT for a name or version that isn't one.
 *
 * @remarks
 * uv fetches, caches and runs the package when the server starts, so nothing is installed now. The
 * server's child env puts uv's cache and Python in its own folder.
 */
export function buildPypiTransport(
  packageName: string,
  version: string | undefined,
  extraArgs: string[] = [],
): ServerTransport {
  const isName = PYPI_NAME.test(packageName);
  if (isName === false) {
    throw badInput(`"${packageName}" is not a PyPI package name.`);
  }
  const pinned = version === undefined || version === '' ? undefined : version;
  assertVersion(pinned);
  const spec = pinned === undefined ? packageName : `${packageName}@${pinned}`;
  return { type: TRANSPORT_STDIO, command: 'uvx', args: [spec, ...extraArgs] };
}

/**
 * Turns a failed child command into the error the caller reads.
 *
 * @param what - The command, as the message starts it.
 * @param error - What it threw.
 * @param timeoutMs - How long it was allowed.
 * @returns UPSTREAM_FAILED for a failure or a timeout. Anything else, such as a refusal, as it was.
 */
function commandFailure(what: string, error: unknown, timeoutMs: number): unknown {
  if (error instanceof ChildCommandError) {
    return error.timedOut
      ? upstreamFailed(`${what} did not finish within ${timeoutMs} ms.`)
      : upstreamFailed(`${what} failed: ${error.detail}`);
  }
  return error;
}

/**
 * Installs an npm package into the server's folder as the server's user, and reads back its program.
 *
 * @param deps - The server's user and folder, and the command runner.
 * @param packageName - The package, scope included.
 * @param version - The version or tag; undefined installs the latest.
 * @param [extraArgs] - Passed after the program.
 * @returns A transport that runs the program with `node`.
 * @throws BAD_USER_INPUT for a name or version that isn't one, or a package with no program.
 * UPSTREAM_FAILED when npm fails or overruns, or the installed package.json can't be read.
 *
 * @remarks
 * The router may not enter the server's folder, so package.json is read by the server's user too. Installs run
 * as the server's own uid and group, with no extra groups, and npm's cache goes in the folder's HOME.
 */
async function installNpmPackage(
  deps: InstallDeps,
  packageName: string,
  version: string | undefined,
  extraArgs: string[] = [],
): Promise<ServerTransport> {
  const isName = NPM_NAME.test(packageName);
  if (isName === false) {
    throw badInput(`"${packageName}" is not an npm package name.`);
  }
  assertVersion(version);
  const { npmTimeoutMs, readTimeoutMs } = { ...INSTALL_DEFAULTS, ...deps.overrides };
  const { isolation, childUid, installDir, exec, helperPath, overrides = {} } = deps;
  const user: ServerUser = {
    isolation,
    runAs: serverChildUser(childUid),
    homeDir: homeOf(installDir),
    exec,
    helperPath,
  };
  const spec = `${packageName}@${version ?? NPM_LATEST}`;
  try {
    await runAsServer(
      user,
      'npm',
      ['install', '--prefix', installDir, spec, '--no-audit', '--no-fund'],
      npmTimeoutMs,
      overrides,
    );
  } catch (error) {
    throw commandFailure(`npm install of "${spec}"`, error, npmTimeoutMs);
  }
  const packageDir = path.join(installDir, 'node_modules', ...packageName.split('/'));
  let text: string;
  try {
    text = await runAsServer(user, 'cat', [path.join(packageDir, 'package.json')], readTimeoutMs, overrides);
  } catch (error) {
    throw commandFailure(`Reading the package.json of "${packageName}"`, error, readTimeoutMs);
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw upstreamFailed(`The installed package.json of "${packageName}" is not JSON.`);
  }
  const bin = resolveBinEntry(packageName, isRecord(manifest) ? manifest.bin : undefined);
  return { type: TRANSPORT_STDIO, command: 'node', args: [path.resolve(packageDir, bin), ...extraArgs] };
}

/** What a source decides, before the request's own source is put back on. */
type SourceParts = Omit<InstallResult, 'source'>;

/** Nothing declared: no headers, env or hints. */
const NOTHING_DECLARED = { headers: {}, env: {}, envMeta: {} };

/**
 * Resolves a registry entry's chosen package or remote, with the env and headers it declares.
 *
 * @param request - Read for the package selector.
 * @param source - Names the registry, the entry, and a version that wins over the entry's.
 * @param deps - Reaches the registry and runs npm.
 * @returns The parts.
 * @throws NOT_FOUND for an unknown registry or entry. BAD_USER_INPUT for a remote that is neither streamable HTTP nor
 * SSE or has no valid URL, or a package that is neither npm nor PyPI. Anything an install throws.
 */
async function registryParts(
  request: InstallRequest,
  source: Extract<InstallSource, { type: typeof SourceType.Registry }>,
  deps: InstallDeps,
): Promise<SourceParts> {
  const registry = await deps.getRegistry(source.registry);
  if (registry === undefined) {
    throw notFound(`There is no registry "${source.registry}".`);
  }
  const client = deps.registryClient ?? new RegistryClient();
  const entry = await client.getServer(registry, source.serverName);
  const selection = selectFromEntry(entry, request.packageSelector);
  const described = { displayName: entry.server.title, description: entry.server.description };
  if ('remote' in selection) {
    const { remote } = selection;
    const type = httpTransportType(remote.type);
    if (type === undefined) {
      throw badInput(`Remote transport "${remote.type}" is not supported; only ${HTTP_TRANSPORTS.join(' and ')} are.`);
    }
    const isUrl = z.url().safeParse(remote.url).success;
    if (isUrl === false) {
      throw badInput(`The registry entry's remote has no valid URL: "${remote.url}".`);
    }
    return {
      ...described,
      ...NOTHING_DECLARED,
      transport: { type, url: remote.url },
      headers: headersFromRegistry(remote.headers),
    };
  }
  const chosen = selection.package;
  const version = source.version ?? chosen.version;
  const args = fixedArgsFrom(chosen.packageArguments);
  let transport: ServerTransport;
  if (chosen.registryType === REGISTRY_TYPE_NPM) {
    transport = await installNpmPackage(deps, chosen.identifier, version, args);
  } else if (chosen.registryType === REGISTRY_TYPE_PYPI) {
    transport = buildPypiTransport(chosen.identifier, version, args);
  } else {
    throw badInput(
      `Only npm and PyPI packages can be installed; "${source.serverName}" offers ${chosen.registryType}.`,
    );
  }
  return { ...described, ...envFromRegistry(chosen.environmentVariables), headers: {}, transport };
}

/**
 * Installs a server, as its own user and into its own folder, and says how to store it.
 *
 * @param request - The source, and the package selector or the manual transport.
 * @param deps - The server's user and folder, the registries, and the command runner.
 * @returns The parts to store. Nothing is saved; an npm package is on disk by then.
 * @throws BAD_USER_INPUT for a manual source with no transport, and as the source's install does.
 * NOT_FOUND for an unknown registry or entry. UPSTREAM_FAILED when the registry or npm fails.
 * CONFLICT when child processes are refused.
 *
 * @remarks
 * A server reached over HTTP needs no folder: when `transport` is streamable HTTP or SSE, the caller removes the one
 * it made.
 */
export async function installServer(request: InstallRequest, deps: InstallDeps): Promise<InstallResult> {
  const { source } = request;
  let parts: SourceParts;
  if (source.type === SourceType.Registry) {
    parts = await registryParts(request, source, deps);
  } else if (source.type === SourceType.Npm) {
    parts = { ...NOTHING_DECLARED, transport: await installNpmPackage(deps, source.package, source.version) };
  } else if (source.type === SourceType.Pypi) {
    parts = { ...NOTHING_DECLARED, transport: buildPypiTransport(source.package, source.version) };
  } else {
    if (request.transport === undefined) {
      throw badInput('A server added by hand needs a command or an address.');
    }
    parts = { ...NOTHING_DECLARED, transport: request.transport };
  }
  return { source, ...parts };
}
