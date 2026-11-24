import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { INSTANCE_DEFAULTS } from '../core/defaults.ts';
import { badInput, conflict, errorMessage, notFound, upstreamFailed } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import { parseOrThrow } from '../core/validation.ts';
import { AGENT_DEPTH_META_KEY } from '../core/wire.ts';
import type { DB } from '../db/client.ts';
import type { SnapshotHost, SnapshotServer, SnapshotServerEntry } from '../db/snapshot.ts';
import { registries } from '../db/tables/registries.ts';
import { SecretKind, serverSecrets } from '../db/tables/server-secrets.ts';
import { servers } from '../db/tables/servers.ts';
import { workspaceServers } from '../db/tables/workspace-servers.ts';
import { type ActivityRecorder, createActivityRecorder } from './activity.ts';
import type {
  DeletedEntry,
  InstallServerRequest,
  RunToolCall,
  ServedInstance,
  ServedRegistryPage,
  ServedServer,
  ServedTool,
  ToolServices,
} from './api.ts';
import { BUILTIN_ONLY, isBuiltin, refuseIfBuiltin, runMeta } from './builtin.ts';
import { type ChildIsolation, serverChildUser } from './child-users.ts';
import { envInput, secretHeadersInput, transportInput } from './input.ts';
import { createInstallFolder, FolderKind, type FolderOptions, removeInstallFolder } from './install-folder.ts';
import { deriveServerName, installServer } from './installer.ts';
import { InstanceError } from './instance.ts';
import { InstanceManager } from './instances.ts';
import { createServerLoginStore } from './login-store.ts';
import { ServerLoginService } from './oauth/service.ts';
import { RegistryClient, type RegistryFetch, type RegistryServerEntry } from './registry.ts';
import { resolveServer, workspaceInstanceEntry } from './resolve.ts';
import {
  httpTransportType,
  type InstallSource,
  installSourceSchema,
  isHttpTransport,
  type ResolvedServer,
  SourceType,
  serverNameSchema,
  TRANSPORT_BUILTIN,
  TRANSPORT_STDIO,
} from './shapes.ts';

/** Characters of a failure kept on an instance's status. */
const MAX_INSTANCE_ERROR = 500;

/** The tools area's running parts, with what boot starts and shutdown stops. */
export interface ToolServiceParts extends ToolServices {
  activity: ActivityRecorder;
  instances: InstanceManager;
  /** Stops every instance and writes the activity still held. */
  stop(): Promise<void>;
}

/** What the tools area is built from. */
export interface ToolServiceDeps {
  db: DB;
  snapshot: SnapshotHost;
  /** What the boot check found. */
  isolation: ChildIsolation;
  /** How registries are reached. The global fetch when absent. */
  registryFetch?: RegistryFetch;
  /** Where install folders go, and how child commands run, for tests. */
  folders?: FolderOptions;
}

/**
 * Turns an instance's failure into what a person is told.
 *
 * @param error - What the instance threw.
 * @returns UPSTREAM_FAILED for a server that couldn't start or answer; anything else as it was.
 */
function asUpstream(error: unknown): unknown {
  return error instanceof InstanceError ? upstreamFailed(error.message) : error;
}

/**
 * Writes a run's tool call's `_meta`.
 *
 * @param server - The server called.
 * @param run - The run the call is for.
 * @returns The run, for the admin server; for any other, the depth an agent the call starts would be at.
 */
function callMeta(server: ResolvedServer, run: RunToolCall): Record<string, unknown> {
  return isBuiltin(server) ? runMeta(run) : { [AGENT_DEPTH_META_KEY]: run.depth };
}

/**
 * Lists what a registry entry can be installed as.
 *
 * @param entry - The entry.
 * @returns One choice per npm or PyPI package, and per streamable-HTTP or SSE remote, by the selector installServer
 * takes.
 */
function choicesOf(entry: RegistryServerEntry): ServedRegistryPage['servers'][number]['choices'] {
  const packages = (entry.server.packages ?? []).flatMap((pkg, index) =>
    pkg.registryType === 'npm' || pkg.registryType === 'pypi'
      ? [{ selector: String(index), kind: pkg.registryType, identifier: pkg.identifier, version: pkg.version ?? null }]
      : [],
  );
  const remotes = (entry.server.remotes ?? []).flatMap((remote, index) =>
    httpTransportType(remote.type) !== undefined
      ? [{ selector: `remote:${index}`, kind: remote.type, identifier: remote.url, version: null }]
      : [],
  );
  return [...packages, ...remotes];
}

/** What a server given headers that is not reached over HTTP is told. */
const HEADERS_NEED_HTTP =
  'Headers are for a server reached over HTTP. A program takes its secrets as env values, under Secrets once it is added.';

/**
 * Lists the secret headers a new server is stored with: the ones its registry remote declares, and the ones it was
 * added with, which win over a declared header of the same name in any case.
 *
 * @param declared - What the registry remote declares, by name.
 * @param given - What the install was given.
 * @returns Each header's name and value, once.
 */
function secretHeadersOf(
  declared: Readonly<Record<string, string>>,
  given: readonly { name: string; value: string }[],
): { name: string; value: string }[] {
  const givenNames = new Set(given.map((header) => header.name.toLowerCase()));
  const kept = Object.entries(declared)
    .filter(([name]) => givenNames.has(name.toLowerCase()) === false)
    .map(([name, value]) => ({ name, value }));
  return [...kept, ...given];
}

/**
 * Hands out the next server user id. Taken before anything is installed, and never handed out again,
 * even when the install fails.
 *
 * @param db - The database.
 * @returns The uid.
 * @throws CONFLICT when every id in the child range has been handed out.
 */
async function nextChildUid(db: DB): Promise<number> {
  let answer: unknown;
  try {
    answer = await db.execute(sql`select nextval('child_uid_seq')::int as uid`);
  } catch (error) {
    throw conflict(`No server user ids are left to hand out: ${errorMessage(error)}`);
  }
  const rows = isRecord(answer) && Array.isArray(answer.rows) ? answer.rows : [];
  const [first]: unknown[] = rows;
  if (isRecord(first) && typeof first.uid === 'number') {
    return first.uid;
  }
  throw new Error('The child uid sequence answered nothing.');
}

/**
 * Builds the tools area's parts. Nothing starts: the activity recorder's timers are the caller's to start.
 *
 * @param deps - The database, the snapshot, the isolation, and stand-ins for tests.
 * @returns The parts.
 */
export function createToolServices({
  db,
  snapshot,
  isolation,
  registryFetch,
  folders = {},
}: ToolServiceDeps): ToolServiceParts {
  const activity = createActivityRecorder(db);
  const logins = new ServerLoginService({ store: createServerLoginStore(db, snapshot) });
  const registryClient = new RegistryClient(registryFetch);
  const instances = new InstanceManager({
    isolation,
    authProviderFor: (resolved) =>
      isHttpTransport(resolved.transport) ? logins.providerFor(resolved.id, resolved.transport.url) : undefined,
  });

  const serverById = (id: string): SnapshotServer => {
    const found = [...snapshot.current().servers.values()].find((server) => server.id === id);
    if (found === undefined) {
      throw notFound('Server not found.');
    }
    return found;
  };

  /**
   * Removes a folder as its owner, logging rather than failing: a folder left behind is never handed to another
   * server, since its uid never is.
   *
   * @param ownerUid - Its owner, whose uid its name starts with.
   * @param name - The folder's name.
   */
  const discardFolder = async (ownerUid: number, name: string): Promise<void> => {
    try {
      await removeInstallFolder(isolation, serverChildUser(ownerUid), name, folders);
    } catch (error) {
      console.error(`[tools] could not remove folder ${name}: ${errorMessage(error)}`);
    }
  };

  /** Folders being made for workspace instances, by entry id, so two first calls make one. */
  const makingFolders = new Map<string, Promise<void>>();

  /**
   * Makes a workspace instance's own folder, as its own uid, and records it on the entry.
   *
   * @param server - The server.
   * @param entry - The workspace's entry for it, which has no folder yet.
   * @returns Resolves once the folder is recorded and the snapshot rebuilt. A folder made for an entry deleted
   * meanwhile is removed again.
   */
  const makeEntryFolder = async (server: SnapshotServer, entry: SnapshotServerEntry): Promise<void> => {
    const runAs = { uid: entry.childUid, gid: server.childUid, groups: [...server.extraGroups] };
    const folder = await createInstallFolder(isolation, runAs, { ...folders, kind: FolderKind.Instance });
    const saved = await db
      .update(workspaceServers)
      .set({ installDir: folder.name })
      .where(and(eq(workspaceServers.id, entry.id), isNull(workspaceServers.installDir)))
      .returning({ id: workspaceServers.id });
    if (saved.length === 0) {
      await discardFolder(entry.childUid, folder.name);
      return;
    }
    await snapshot.rebuild();
  };

  /**
   * Makes sure a workspace instance has its folder, once per entry however many calls ask at once.
   *
   * @param server - The server.
   * @param entry - The entry.
   * @returns Resolves once it has one.
   */
  const ensureEntryFolder = (server: SnapshotServer, entry: SnapshotServerEntry): Promise<void> => {
    const pending = makingFolders.get(entry.id);
    if (pending !== undefined) {
      return pending;
    }
    const making = makeEntryFolder(server, entry).finally(() => makingFolders.delete(entry.id));
    makingFolders.set(entry.id, making);
    return making;
  };

  /**
   * Resolves what an instance runs with, first making a stdio workspace instance's folder when it has none.
   *
   * @param serverId - The server.
   * @param workspaceId - The workspace whose instance is wanted, or null for the base instance.
   * @returns The server as resolved.
   * @throws BAD_USER_INPUT for a server that is turned off; NOT_FOUND for no such server.
   */
  const resolve = async (serverId: string, workspaceId: string | null): Promise<ResolvedServer> => {
    const server = serverById(serverId);
    if (server.enabled === false) {
      throw badInput(`Server "${server.name}" is turned off.`);
    }
    const resolved = resolveServer(server, workspaceId, INSTANCE_DEFAULTS, folders.root);
    const entry = workspaceInstanceEntry(server, workspaceId);
    const hasHome = resolved.transport.type !== TRANSPORT_STDIO || resolved.homeDir !== null;
    if (entry === undefined || hasHome) {
      return resolved;
    }
    await ensureEntryFolder(server, entry);
    return resolveServer(serverById(serverId), workspaceId, INSTANCE_DEFAULTS, folders.root);
  };

  const getRegistry = async (name: string) => {
    const [row] = await db.select().from(registries).where(eq(registries.name, name));
    return row === undefined ? undefined : { name: row.name, url: row.url };
  };

  const install = async (request: InstallServerRequest): Promise<ServedServer> => {
    const asksForBuiltin = request.source.type === SourceType.Builtin || request.transport?.type === TRANSPORT_BUILTIN;
    if (asksForBuiltin) {
      throw badInput(BUILTIN_ONLY);
    }
    const source: InstallSource = parseOrThrow(installSourceSchema, {
      type: request.source.type,
      ...Object.fromEntries(
        Object.entries(request.source).filter(([, value]) => value !== null && value !== undefined),
      ),
    });
    const transport =
      request.transport === null || request.transport === undefined
        ? undefined
        : parseOrThrow(transportInput, {
            type: request.transport.type,
            ...(request.transport.command === null || request.transport.command === undefined
              ? {}
              : { command: request.transport.command }),
            ...(request.transport.args === null || request.transport.args === undefined
              ? {}
              : { args: request.transport.args }),
            ...(request.transport.url === null || request.transport.url === undefined
              ? {}
              : { url: request.transport.url }),
          });
    const env = parseOrThrow(envInput, request.env ?? {});
    const givenHeaders = parseOrThrow(secretHeadersInput, request.headers ?? []);
    const requestedName = request.name?.trim() ?? '';
    if (requestedName === '' && source.type === SourceType.Manual) {
      throw badInput('Name a server added by hand.');
    }
    const name = parseOrThrow(serverNameSchema, requestedName === '' ? deriveServerName(source) : requestedName);
    const [taken] = await db.select({ id: servers.id }).from(servers).where(eq(servers.name, name));
    if (taken !== undefined) {
      throw badInput('A server with that name already exists.');
    }
    const childUid = await nextChildUid(db);
    const needsFolder = transport === undefined || isHttpTransport(transport) === false;
    const folder = needsFolder ? await createInstallFolder(isolation, serverChildUser(childUid), folders) : null;
    try {
      const result = await installServer(
        {
          source,
          ...(request.packageSelector === null || request.packageSelector === undefined
            ? {}
            : { packageSelector: request.packageSelector }),
          ...(transport === undefined ? {} : { transport }),
        },
        { isolation, childUid, installDir: folder?.path ?? '', getRegistry, registryClient, ...folders },
      );
      const isHttp = isHttpTransport(result.transport);
      if (givenHeaders.length > 0 && isHttp === false) {
        throw badInput(HEADERS_NEED_HTTP);
      }
      const keepsFolder = folder !== null && isHttp === false;
      if (folder !== null && keepsFolder === false) {
        await discardFolder(childUid, folder.name);
      }
      const row = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(servers)
          .values({
            name,
            displayName: result.displayName ?? null,
            description: result.description ?? '',
            enabled: request.enabled ?? true,
            source: result.source,
            transport: result.transport,
            env: { ...result.env, ...env },
            envMeta: result.envMeta,
            childUid,
            installDir: keepsFolder ? folder.name : null,
          })
          .returning();
        if (inserted === undefined) {
          throw new Error('The server insert returned no row.');
        }
        const headers = secretHeadersOf(result.headers, givenHeaders);
        if (headers.length > 0) {
          await tx.insert(serverSecrets).values(
            headers.map(({ name: header, value }) => ({
              serverId: inserted.id,
              workspaceId: null,
              kind: SecretKind.Header,
              name: header,
              value,
            })),
          );
        }
        return inserted;
      });
      await snapshot.rebuild();
      const { oauth: _secret, ...served } = row;
      return served;
    } catch (error) {
      if (folder !== null) {
        await discardFolder(childUid, folder.name);
      }
      throw error;
    }
  };

  const remove = async (serverId: string): Promise<boolean> => {
    const [row] = await db.select().from(servers).where(eq(servers.id, serverId));
    if (row === undefined) {
      return false;
    }
    refuseIfBuiltin(row, "it can't be deleted");
    const entries = await db
      .select({ childUid: workspaceServers.childUid, installDir: workspaceServers.installDir })
      .from(workspaceServers)
      .where(eq(workspaceServers.serverId, row.id));
    await instances.forget(row.id);
    logins.forget(row.id);
    await db.delete(servers).where(eq(servers.id, row.id));
    await snapshot.rebuild();
    const owned = [{ childUid: row.childUid, installDir: row.installDir }, ...entries];
    for (const { childUid, installDir } of owned) {
      if (installDir !== null) {
        await discardFolder(childUid, installDir);
      }
    }
    return true;
  };

  const forgetEntries = async (entries: readonly DeletedEntry[]): Promise<void> => {
    for (const { serverId, workspaceId, childUid, installDir } of entries) {
      await instances.stop(serverId, workspaceId);
      if (installDir !== null) {
        await discardFolder(childUid, installDir);
      }
    }
  };

  const listTools = async (serverId: string, workspaceId: string | null): Promise<ServedTool[]> => {
    const resolved = await resolve(serverId, workspaceId);
    try {
      const tools = await instances.listTools(resolved);
      return tools.map((tool) => ({
        name: tool.name,
        title: tool.title ?? tool.annotations?.title ?? null,
        description: tool.description ?? null,
        inputSchema: tool.inputSchema,
      }));
    } catch (error) {
      throw asUpstream(error);
    }
  };

  const callTool = async (
    serverId: string,
    workspaceId: string | null,
    tool: string,
    args: Record<string, unknown>,
    run?: RunToolCall,
  ): Promise<CallToolResult> => {
    const resolved = await resolve(serverId, workspaceId);
    if (run === undefined) {
      refuseIfBuiltin(resolved, 'its tools are for agent runs that name it, and a person does the same in the UI');
    }
    // Who made the call: the run's workspace, whichever instance answers it.
    const callerWorkspaceId = run?.workspaceId ?? workspaceId;
    const workspace = callerWorkspaceId === null ? undefined : snapshot.current().workspaces.get(callerWorkspaceId);
    const startedAt = performance.now();
    const record = (ok: boolean, error: string | null): void =>
      activity.record({
        serverId: resolved.id,
        serverName: resolved.name,
        workspaceId: workspace?.id ?? null,
        workspaceName: workspace?.slug ?? null,
        agentId: run?.agentId ?? null,
        agentName: run?.agentName ?? null,
        runId: run?.runId ?? null,
        tool,
        durationMs: Math.round(performance.now() - startedAt),
        ok,
        error,
      });
    try {
      const result = await instances.callTool(resolved, tool, args, {
        ...(run?.signal === undefined ? {} : { signal: run.signal }),
        ...(run?.onProgress === undefined ? {} : { onProgress: run.onProgress }),
        ...(run?.onElicit === undefined ? {} : { onElicit: run.onElicit }),
        ...(run === undefined ? {} : { meta: callMeta(resolved, run) }),
      });
      record(result.isError !== true, result.isError === true ? 'The tool answered an error.' : null);
      return result;
    } catch (error) {
      record(false, errorMessage(error));
      throw asUpstream(error);
    }
  };

  const listInstances = (serverId: string): ServedInstance[] =>
    instances.list(serverId).map((instance) => ({
      workspaceId: instance.server.workspaceId,
      state: instance.state,
      error: instance.error === '' ? null : instance.error.slice(-MAX_INSTANCE_ERROR),
      inFlight: instance.inFlightCount,
    }));

  const browse = async (
    registryId: string,
    search: string | null,
    cursor: string | null,
  ): Promise<ServedRegistryPage> => {
    const [row] = await db.select().from(registries).where(eq(registries.id, registryId));
    if (row === undefined) {
      throw notFound('Registry not found.');
    }
    const page = await registryClient.listServers(
      { name: row.name, url: row.url },
      { ...(search === null ? {} : { search }), ...(cursor === null ? {} : { cursor }) },
    );
    return {
      servers: page.servers.map((entry) => ({
        name: entry.server.name,
        title: entry.server.title ?? null,
        description: entry.server.description ?? null,
        version: entry.server.version ?? null,
        choices: choicesOf(entry),
      })),
      nextCursor: page.metadata?.nextCursor ?? null,
    };
  };

  return {
    activity,
    instances,
    logins,
    install,
    remove,
    forgetEntries,
    listTools,
    callTool,
    instanceStates: listInstances,
    restart: (serverId, workspaceId) => instances.stop(serverId, workspaceId),
    browse,
    async stop() {
      await instances.stopAll();
      await activity.stop();
    },
  };
}
