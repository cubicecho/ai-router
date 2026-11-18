import type { ServerRow } from '../db/tables/servers.ts';
import type { ServerLoginService } from './oauth/service.ts';

/** A server row as the API serves it: everything but its login. */
export type ServedServer = Omit<ServerRow, 'oauth'>;

/** What `installServer` takes, as the GraphQL input states it. */
export interface InstallServerRequest {
  /** The server's name. Derived from the package or registry entry when left out. */
  name?: string | null;
  source: {
    type: string;
    registry?: string | null;
    serverName?: string | null;
    package?: string | null;
    version?: string | null;
  };
  /** Which of a registry entry's packages or remotes: `<index>` or `remote:<index>`. */
  packageSelector?: string | null;
  /** For a server added by hand. */
  transport?: { type: string; command?: string | null; args?: string[] | null; url?: string | null } | null;
  env?: Record<string, string> | null;
  enabled?: boolean | null;
}

/** One tool a server offers, as the UI lists it. */
export interface ServedTool {
  name: string;
  title: string | null;
  description: string | null;
  inputSchema: unknown;
}

/** One running or stopped connection to a server. */
export interface ServedInstance {
  /** null for the base instance. */
  workspaceId: string | null;
  state: string;
  /** Why it last failed, cut short. */
  error: string | null;
  inFlight: number;
}

/** One entry of a registry, as the install dialog lists it. */
export interface ServedRegistryServer {
  name: string;
  title: string | null;
  description: string | null;
  version: string | null;
  /** What can be installed from it, by selector. */
  choices: { selector: string; kind: string; identifier: string; version: string | null }[];
}

/** One page of a registry's entries. */
export interface ServedRegistryPage {
  servers: ServedRegistryServer[];
  /** Pass it back for the next page. null on the last. */
  nextCursor: string | null;
}

/** The tools area's running parts, as the GraphQL resolvers use them. */
export interface ToolServices {
  /** Installs or adds a server, and saves it. */
  install(request: InstallServerRequest): Promise<ServedServer>;
  /** Stops a server's instances, removes its folder, and deletes it. false when there is no such server. */
  remove(serverId: string): Promise<boolean>;
  /** Lists a server's tools, starting an instance if none runs. */
  listTools(serverId: string, workspaceId: string | null): Promise<ServedTool[]>;
  /** Calls one tool as a person trying it from the UI, and records the call. */
  callTool(serverId: string, workspaceId: string | null, tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** A server's instances, base first. */
  instanceStates(serverId: string): ServedInstance[];
  /** Stops an instance, so the next call starts it again. */
  restart(serverId: string, workspaceId: string | null): Promise<void>;
  /** Searches a registry. */
  browse(registryId: string, search: string | null, cursor: string | null): Promise<ServedRegistryPage>;
  /** Remote servers' logins. */
  logins: ServerLoginService;
}
