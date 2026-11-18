import { defineRelations } from 'drizzle-orm';
import * as schema from './schema.ts';

/** Drizzle v2 relations. drizzle-graphql generates nested read fields from these. */
export const relations = defineRelations(schema, (relate) => ({
  workspaces: {
    keys: relate.many.workspaceKeys(),
    usage: relate.many.usageCounts(),
    servers: relate.many.workspaceServers(),
    activity: relate.many.activity(),
    agents: relate.many.workspaceAgents(),
  },
  workspaceKeys: {
    workspace: relate.one.workspaces({ from: relate.workspaceKeys.workspaceId, to: relate.workspaces.id }),
    creator: relate.one.users({ from: relate.workspaceKeys.createdBy, to: relate.users.id }),
  },
  providers: { targets: relate.many.poolTargets(), usage: relate.many.usageCounts() },
  pools: { targets: relate.many.poolTargets() },
  poolTargets: {
    pool: relate.one.pools({ from: relate.poolTargets.poolId, to: relate.pools.id }),
    provider: relate.one.providers({ from: relate.poolTargets.providerId, to: relate.providers.id }),
  },
  usageCounts: {
    workspace: relate.one.workspaces({ from: relate.usageCounts.workspaceId, to: relate.workspaces.id }),
    provider: relate.one.providers({ from: relate.usageCounts.providerId, to: relate.providers.id }),
    agent: relate.one.agents({ from: relate.usageCounts.agentId, to: relate.agents.id }),
  },
  servers: {
    secrets: relate.many.serverSecrets(),
    workspaces: relate.many.workspaceServers(),
    activity: relate.many.activity(),
  },
  serverSecrets: {
    server: relate.one.servers({ from: relate.serverSecrets.serverId, to: relate.servers.id }),
    workspace: relate.one.workspaces({ from: relate.serverSecrets.workspaceId, to: relate.workspaces.id }),
  },
  workspaceServers: {
    workspace: relate.one.workspaces({ from: relate.workspaceServers.workspaceId, to: relate.workspaces.id }),
    server: relate.one.servers({ from: relate.workspaceServers.serverId, to: relate.servers.id }),
  },
  agents: {
    revisions: relate.many.agentRevisions(),
    liveRevision: relate.one.agentRevisions({ from: relate.agents.liveRevisionId, to: relate.agentRevisions.id }),
    overridePolicy: relate.one.overridePolicies({
      from: relate.agents.overridePolicyId,
      to: relate.overridePolicies.id,
    }),
    workspaces: relate.many.workspaceAgents(),
    usage: relate.many.usageCounts(),
  },
  agentRevisions: {
    agent: relate.one.agents({ from: relate.agentRevisions.agentId, to: relate.agents.id }),
    creator: relate.one.users({ from: relate.agentRevisions.createdBy, to: relate.users.id }),
  },
  overridePolicies: { agents: relate.many.agents() },
  workspaceAgents: {
    workspace: relate.one.workspaces({ from: relate.workspaceAgents.workspaceId, to: relate.workspaces.id }),
    agent: relate.one.agents({ from: relate.workspaceAgents.agentId, to: relate.agents.id }),
  },
  activity: {
    server: relate.one.servers({ from: relate.activity.serverId, to: relate.servers.id }),
    workspace: relate.one.workspaces({ from: relate.activity.workspaceId, to: relate.workspaces.id }),
    agent: relate.one.agents({ from: relate.activity.agentId, to: relate.agents.id }),
  },
}));
