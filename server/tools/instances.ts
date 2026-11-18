import { createHash } from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { InstanceSettings } from '../core/defaults.ts';
import { errorMessage } from '../core/errors.ts';
import { isRecord } from '../core/is-record.ts';
import type { ChildIsolation } from './child-users.ts';
import { type CallOptions, Instance, type ToolCallHook } from './instance.ts';
import type { ResolvedServer } from './shapes.ts';

/** What the manager is built with. */
export interface InstanceManagerOptions {
  /** How stdio programs run, from the boot check. A refused mode refuses every stdio server, with its reason. */
  isolation: ChildIsolation;
  /** Hears of every tool call, on every instance. */
  onCall?: ToolCallHook;
  /** Finds the login a streamable-HTTP server signs in with. Asked once per instance it starts. */
  authProviderFor?: (server: ResolvedServer) => OAuthClientProvider | undefined;
}

/** One instance, and the settings it was built from. */
interface Held {
  instance: Instance;
  /** A hash of the `ResolvedServer` it runs. Another hash means the settings changed. */
  fingerprint: string;
}

/**
 * Rebuilds a value with every object's keys in order, so the same settings always print the same.
 *
 * @param value - A JSON-shaped value.
 * @returns The value, its objects' keys sorted.
 */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedKeys);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortedKeys(value[key])]),
    );
  }
  return value;
}

/**
 * Hashes everything an instance runs with, so a change to any of it is noticed.
 *
 * @param server - The server as resolved for the instance.
 * @returns 64 hex characters of SHA-256. A hash, so nothing holding it holds the secrets in `env` or `headers`.
 */
export function serverFingerprint(server: ResolvedServer): string {
  return createHash('sha256')
    .update(JSON.stringify(sortedKeys(server)))
    .digest('hex');
}

/**
 * Names an instance: one per server and workspace, the base instance under a null workspace.
 *
 * @param serverId - The server.
 * @param workspaceId - The workspace, or null.
 * @returns The key.
 */
function instanceKey(serverId: string, workspaceId: string | null): string {
  return JSON.stringify([serverId, workspaceId]);
}

/**
 * Every instance the router runs, by server and workspace, for agent runs to list and call tools on.
 *
 * @remarks
 * An instance is made on first use and started on its first call. A `ResolvedServer` that differs from the one an
 * instance was built from replaces it: the new one takes the next call, and the old one stops once its calls in
 * flight are done.
 */
export class InstanceManager {
  private readonly options: InstanceManagerOptions;
  private readonly overrides: Partial<InstanceSettings>;
  private readonly held = new Map<string, Held>();
  /** Replaced instances still finishing their calls. */
  private readonly retiring = new Set<Instance>();

  /**
   * Builds a manager with no instances.
   *
   * @param options - The isolation mode, the call hook and the login lookup.
   * @param [overrides] - Settings that differ from `INSTANCE_DEFAULTS`, for every instance.
   */
  constructor(options: InstanceManagerOptions, overrides: Partial<InstanceSettings> = {}) {
    this.options = options;
    this.overrides = overrides;
  }

  /**
   * Finds the instance for a server as resolved, making it when there is none or its settings changed.
   *
   * @param resolved - The server, for the base instance or one workspace's.
   * @returns The instance, not necessarily started.
   */
  instanceFor(resolved: ResolvedServer): Instance {
    const key = instanceKey(resolved.id, resolved.workspaceId);
    const fingerprint = serverFingerprint(resolved);
    const held = this.held.get(key);
    if (held?.fingerprint === fingerprint) {
      return held.instance;
    }
    if (held !== undefined) {
      this.retire(held.instance);
    }
    const { isolation, onCall, authProviderFor } = this.options;
    const instance = new Instance(
      resolved,
      { isolation, onCall, authProvider: authProviderFor?.(resolved) },
      this.overrides,
    );
    this.held.set(key, { instance, fingerprint });
    return instance;
  }

  /**
   * Starts the instance for a server, or reuses the running one.
   *
   * @param resolved - The server as resolved.
   * @returns The ready instance. Throws an `InstanceError` when it is refused, backed off, or won't start.
   */
  async get(resolved: ResolvedServer): Promise<Instance> {
    const instance = this.instanceFor(resolved);
    await instance.start();
    return instance;
  }

  /**
   * Lists a server's tools, by their own names.
   *
   * @param resolved - The server as resolved.
   * @returns The tools; a kept list is answered without starting the server.
   */
  listTools(resolved: ResolvedServer): Promise<Tool[]> {
    return this.instanceFor(resolved).listTools();
  }

  /**
   * Calls one of a server's tools.
   *
   * @param resolved - The server as resolved.
   * @param tool - The tool's name at the server.
   * @param args - Its arguments.
   * @param [options] - An abort signal, and a shorter timeout.
   * @returns What the tool answered. Throws as `Instance.callTool` does.
   */
  callTool(
    resolved: ResolvedServer,
    tool: string,
    args: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<CallToolResult> {
    return this.instanceFor(resolved).callTool(tool, args, options);
  }

  /**
   * Stops and drops every instance of a server, base and workspace, for a server that was deleted or disabled.
   *
   * @param serverId - The server.
   * @returns Resolves once they are stopped.
   */
  async forget(serverId: string): Promise<void> {
    const stopping: Promise<void>[] = [];
    for (const [key, { instance }] of this.held) {
      if (instance.server.id === serverId) {
        this.held.delete(key);
        stopping.push(instance.stop());
      }
    }
    await Promise.all(stopping);
  }

  /**
   * Lists a server's instances, the base one first.
   *
   * @param serverId - The server.
   * @returns Its instances held now, running or not.
   */
  list(serverId: string): Instance[] {
    return [...this.held.values()]
      .map(({ instance }) => instance)
      .filter((instance) => instance.server.id === serverId)
      .sort((a, b) => Number(a.server.workspaceId !== null) - Number(b.server.workspaceId !== null));
  }

  /**
   * Stops one instance, so the next call starts it fresh.
   *
   * @param serverId - The server.
   * @param workspaceId - The workspace whose instance it is; null for the base instance.
   */
  async stop(serverId: string, workspaceId: string | null): Promise<void> {
    const key = instanceKey(serverId, workspaceId);
    const held = this.held.get(key);
    this.held.delete(key);
    await held?.instance.stop();
  }

  /**
   * Stops every instance, for shutdown. The manager stays usable: the next call starts its instance again.
   *
   * @returns Resolves once every program has exited or been signalled.
   */
  async stopAll(): Promise<void> {
    const instances = [...[...this.held.values()].map(({ instance }) => instance), ...this.retiring];
    this.held.clear();
    this.retiring.clear();
    await Promise.all(instances.map((instance) => instance.stop()));
  }

  /**
   * Lets an instance whose settings changed finish its calls, then stop.
   *
   * @param instance - The replaced instance.
   */
  private retire(instance: Instance): void {
    this.retiring.add(instance);
    instance
      .retire()
      .catch((error: unknown) => {
        console.error(`[tools] stopping "${instance.server.name}" failed: ${errorMessage(error)}`);
      })
      .finally(() => this.retiring.delete(instance));
  }
}
