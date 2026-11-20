import { asc, eq } from 'drizzle-orm';
import type { OverridePolicyRules } from '../agents/policy.ts';
import type { AdminRole } from '../core/admin-roles.ts';
import { ROUTER_DEFAULTS, type RouterSettings } from '../core/defaults.ts';
import { routerSettingsFrom, savedSettingsFrom } from '../core/settings.ts';
import type { ServerOAuth, ServerTransport } from '../tools/shapes.ts';
import type { DB } from './client.ts';
import { agentRevisions } from './tables/agent-revisions.ts';
import { agents } from './tables/agents.ts';
import { overridePolicies } from './tables/override-policies.ts';
import { poolTargets } from './tables/pool-targets.ts';
import { type PoolAffinity, type PoolStrategy, pools } from './tables/pools.ts';
import { providers } from './tables/providers.ts';
import { SecretKind, serverSecrets } from './tables/server-secrets.ts';
import { servers } from './tables/servers.ts';
import { settings } from './tables/settings.ts';
import { workspaceAgentServers } from './tables/workspace-agent-servers.ts';
import { workspaceAgents } from './tables/workspace-agents.ts';
import { workspaceKeys } from './tables/workspace-keys.ts';
import { workspaceServers } from './tables/workspace-servers.ts';
import { workspaces } from './tables/workspaces.ts';

/** A workspace as the gateways see it. */
export interface SnapshotWorkspace {
  id: string;
  slug: string;
  name: string;
}

/** A workspace key as the gateways see it, found by its hash. */
export interface SnapshotKey {
  keyId: string;
  workspaceId: string;
  /** null for a key that never expires. */
  expiresAt: Date | null;
}

/** A provider as a run's model calls see it. */
export interface SnapshotProvider {
  id: string;
  name: string;
  enabled: boolean;
  baseUrl: string;
  /** null when none is set. */
  apiKey: string | null;
  headers: Readonly<Record<string, string>>;
  /** When it last changed, so a model list fetched before then is stale. */
  updatedAt: Date;
}

/** One place a pool can send a call. */
export interface SnapshotTarget {
  providerId: string;
  /** The provider's name, as `providers` is keyed. */
  providerName: string;
  /** The model's id at the provider. */
  model: string;
  /** Its share of the pool's calls, at least 1. */
  weight: number;
}

/** A pool as a run's model calls see it. */
export interface SnapshotPool {
  id: string;
  name: string;
  enabled: boolean;
  strategy: PoolStrategy;
  affinity: PoolAffinity;
  /** null for bounded load off. */
  maxLoadFactor: number | null;
  /** In the pool's order. */
  targets: readonly SnapshotTarget[];
}

/** One workspace's settings for a server, secrets included. */
export interface SnapshotServerEntry {
  id: string;
  /** The uid its workspace instance runs as, with the server's group. */
  childUid: number;
  /** Its workspace instance's folder. null until the instance first starts. */
  installDir: string | null;
  /** Merged over the server's env, secret values included. */
  env: Readonly<Record<string, string>>;
  /** Merged over the server's headers. */
  headers: Readonly<Record<string, string>>;
  /** Replaces a stdio server's arguments. null keeps them. */
  args: readonly string[] | null;
  /** Replaces an HTTP server's address. null keeps it. */
  url: string | null;
  /** For the admin server only: what the workspace's agent runs may do through it. Empty for every other server. */
  roles: readonly AdminRole[];
}

/** A server as a run's tool calls see it, secrets included. */
export interface SnapshotServer {
  id: string;
  name: string;
  enabled: boolean;
  transport: ServerTransport;
  /** Its env, secret values included. */
  env: Readonly<Record<string, string>>;
  /** Header values, for a server reached over HTTP. All secret. */
  headers: Readonly<Record<string, string>>;
  childUid: number;
  installDir: string | null;
  /** The extra groups its programs run with, for mounted folders. */
  extraGroups: readonly number[];
  /** null for the router's default. */
  idleTimeoutMs: number | null;
  /** null for the router's default. */
  callTimeoutMs: number | null;
  /** Whether the router holds a login for it. */
  signedIn: boolean;
  /** Its login, tokens included: read on every request an HTTP instance sends, so never from the database. */
  oauth: ServerOAuth | null;
  /** By workspace id: the workspaces with an entry for it. */
  entries: ReadonlyMap<string, SnapshotServerEntry>;
}

/** An agent as a run sees it: its live document, its policy and who may run it. */
export interface SnapshotAgent {
  id: string;
  name: string;
  /** null for an agent with no live revision, which cannot run. */
  liveRevisionId: string | null;
  /** The live revision's document, as stored. null with no live revision. */
  document: Readonly<Record<string, unknown>> | null;
  /** What the layers above it may change. */
  policy: OverridePolicyRules;
  /**
   * The workspaces whose apps may run it, each with the servers it may use there, by name: exactly those, and none
   * when the list is empty. The agent's own `tools.servers` is not read.
   */
  workspaces: ReadonlyMap<string, readonly string[]>;
}

/** Everything requests route by, read once and held in memory. */
export interface Snapshot {
  /** By id. */
  workspaces: ReadonlyMap<string, SnapshotWorkspace>;
  /** By the key's SHA-256, in hex. */
  keys: ReadonlyMap<string, SnapshotKey>;
  /** By name, as a model id names them. */
  providers: ReadonlyMap<string, SnapshotProvider>;
  /** By name, as a model id names them. */
  pools: ReadonlyMap<string, SnapshotPool>;
  /** By name, as a tool's name starts. */
  servers: ReadonlyMap<string, SnapshotServer>;
  /** By name, as an app picks one for its model. */
  agents: ReadonlyMap<string, SnapshotAgent>;
  /** The router's settings in force: the defaults, with what an admin saved over them. */
  settings: Readonly<RouterSettings>;
}

/** A snapshot with nothing in it. */
export const EMPTY_SNAPSHOT: Snapshot = Object.freeze({
  workspaces: new Map(),
  keys: new Map(),
  providers: new Map(),
  pools: new Map(),
  servers: new Map(),
  agents: new Map(),
  settings: ROUTER_DEFAULTS,
});

/** Holds the current snapshot, and builds a new one after a write. */
export interface SnapshotHost {
  /** The snapshot to route this request by. */
  current: () => Snapshot;
  /**
   * Reads everything again. Call it after the write's transaction commits.
   *
   * @remarks
   * Calls that arrive while a read is waiting to start share it. A call during a read queues one more,
   * so every committed write is seen. A failed read keeps the old snapshot and rejects.
   */
  rebuild: () => Promise<void>;
}

/** One secret, keyed by where it belongs. */
type SecretRow = typeof serverSecrets.$inferSelect;

/**
 * Builds the servers' part of the snapshot.
 *
 * @param serverRows - Every server.
 * @param secretRows - Every secret, the servers' own and workspaces' overrides.
 * @param entryRows - Every server entry.
 * @returns The servers by name, with their secrets and entries merged in.
 */
function serversFrom(
  serverRows: (typeof servers.$inferSelect)[],
  secretRows: SecretRow[],
  entryRows: (typeof workspaceServers.$inferSelect)[],
): Map<string, SnapshotServer> {
  /** One server's secret values of one kind: its own (workspace null), or one workspace's. */
  const secretsOf = (serverId: string, workspaceId: string | null, kind: SecretKind): Record<string, string> =>
    Object.fromEntries(
      secretRows
        .filter((row) => row.serverId === serverId && row.workspaceId === workspaceId && row.kind === kind)
        .map((row) => [row.name, row.value]),
    );
  const result = new Map<string, SnapshotServer>();
  for (const row of serverRows) {
    const entries = new Map<string, SnapshotServerEntry>();
    for (const entry of entryRows.filter((candidate) => candidate.serverId === row.id)) {
      entries.set(entry.workspaceId, {
        id: entry.id,
        childUid: entry.childUid,
        installDir: entry.installDir,
        env: { ...entry.env, ...secretsOf(row.id, entry.workspaceId, SecretKind.Env) },
        headers: secretsOf(row.id, entry.workspaceId, SecretKind.Header),
        args: entry.args,
        url: entry.url,
        roles: entry.roles,
      });
    }
    result.set(row.name, {
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      transport: row.transport,
      env: { ...row.env, ...secretsOf(row.id, null, SecretKind.Env) },
      headers: secretsOf(row.id, null, SecretKind.Header),
      childUid: row.childUid,
      installDir: row.installDir,
      extraGroups: row.extraGroups,
      idleTimeoutMs: row.idleTimeoutMs,
      callTimeoutMs: row.callTimeoutMs,
      signedIn: row.signedIn,
      oauth: row.oauth,
      entries,
    });
  }
  return result;
}

/**
 * Reads the snapshot from the database.
 *
 * @param db - The router's database.
 * @returns A new snapshot.
 */
export async function loadSnapshot(db: DB): Promise<Snapshot> {
  const [
    workspaceRows,
    keyRows,
    providerRows,
    poolRows,
    targetRows,
    serverRows,
    secretRows,
    entryRows,
    agentRows,
    policyRows,
    offerRows,
    serverGrantRows,
    [settingsRow],
  ] = await Promise.all([
    db.select({ id: workspaces.id, slug: workspaces.slug, name: workspaces.name }).from(workspaces),
    db
      .select({
        keyId: workspaceKeys.id,
        workspaceId: workspaceKeys.workspaceId,
        hash: workspaceKeys.hash,
        expiresAt: workspaceKeys.expiresAt,
      })
      .from(workspaceKeys),
    db
      .select({
        id: providers.id,
        name: providers.name,
        enabled: providers.enabled,
        baseUrl: providers.baseUrl,
        apiKey: providers.apiKey,
        headers: providers.headers,
        updatedAt: providers.updatedAt,
      })
      .from(providers),
    db.select().from(pools),
    db.select().from(poolTargets).orderBy(asc(poolTargets.position)),
    db.select().from(servers),
    db.select().from(serverSecrets),
    db.select().from(workspaceServers),
    db
      .select({
        id: agents.id,
        name: agents.name,
        liveRevisionId: agents.liveRevisionId,
        overridePolicyId: agents.overridePolicyId,
        document: agentRevisions.document,
      })
      .from(agents)
      .leftJoin(agentRevisions, eq(agentRevisions.id, agents.liveRevisionId)),
    db.select({ id: overridePolicies.id, rules: overridePolicies.rules }).from(overridePolicies),
    db
      .select({ id: workspaceAgents.id, workspaceId: workspaceAgents.workspaceId, agentId: workspaceAgents.agentId })
      .from(workspaceAgents),
    db
      .select({ workspaceAgentId: workspaceAgentServers.workspaceAgentId, serverId: workspaceAgentServers.serverId })
      .from(workspaceAgentServers),
    db.select({ values: settings.values }).from(settings),
  ]);
  const policies = new Map(policyRows.map((row) => [row.id, row.rules]));
  const serverNames = new Map(serverRows.map((row) => [row.id, row.name]));
  /** The names of the servers one workspace's offer of an agent grants it. */
  const serverNamesOf = (workspaceAgentId: string): string[] =>
    serverGrantRows.flatMap((grant) =>
      grant.workspaceAgentId === workspaceAgentId ? (serverNames.get(grant.serverId) ?? []) : [],
    );
  const providerNames = new Map(providerRows.map((row) => [row.id, row.name]));
  const targetsByPool = new Map<string, SnapshotTarget[]>();
  for (const { poolId, providerId, model, weight } of targetRows) {
    const providerName = providerNames.get(providerId) ?? '';
    targetsByPool.set(poolId, [...(targetsByPool.get(poolId) ?? []), { providerId, providerName, model, weight }]);
  }
  return {
    settings: routerSettingsFrom(savedSettingsFrom(settingsRow?.values)),
    servers: serversFrom(serverRows, secretRows, entryRows),
    agents: new Map(
      agentRows.flatMap((row) => {
        const policy = policies.get(row.overridePolicyId);
        if (policy === undefined) {
          return [];
        }
        const workspaces = new Map(
          offerRows
            .filter((offer) => offer.agentId === row.id)
            .map((offer) => [offer.workspaceId, serverNamesOf(offer.id)] as const),
        );
        const agent: SnapshotAgent = {
          id: row.id,
          name: row.name,
          liveRevisionId: row.liveRevisionId,
          document: row.document,
          policy,
          workspaces,
        };
        return [[row.name, agent] as const];
      }),
    ),
    workspaces: new Map(workspaceRows.map((row) => [row.id, row])),
    keys: new Map(keyRows.map(({ hash, ...key }) => [hash, key])),
    providers: new Map(providerRows.map((row) => [row.name, row])),
    pools: new Map(
      poolRows.map((row) => [
        row.name,
        {
          id: row.id,
          name: row.name,
          enabled: row.enabled,
          strategy: row.strategy,
          affinity: row.affinity,
          maxLoadFactor: row.maxLoadFactor,
          targets: targetsByPool.get(row.id) ?? [],
        },
      ]),
    ),
  };
}

/**
 * Builds the snapshot host, with its first snapshot read.
 *
 * @param db - The router's database. Migrations must have run.
 * @param [load] - How a snapshot is read. Tests pass their own.
 * @returns The host.
 */
export async function createSnapshotHost(
  db: DB,
  load: (db: DB) => Promise<Snapshot> = loadSnapshot,
): Promise<SnapshotHost> {
  let snapshot = await load(db);
  let latest: Promise<void> = Promise.resolve();
  let waiting: Promise<void> | null = null;
  return {
    current: () => snapshot,
    rebuild: () => {
      if (waiting !== null) {
        return waiting;
      }
      const next = latest
        .catch(() => {})
        .then(async () => {
          // From here on, a new write needs a read of its own.
          waiting = null;
          snapshot = await load(db);
        });
      waiting = next;
      latest = next;
      return next;
    },
  };
}
