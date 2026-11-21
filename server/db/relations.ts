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
    runs: relate.many.runs(),
    conversations: relate.many.conversations(),
  },
  workspaceKeys: {
    workspace: relate.one.workspaces({ from: relate.workspaceKeys.workspaceId, to: relate.workspaces.id }),
    creator: relate.one.users({ from: relate.workspaceKeys.createdBy, to: relate.users.id }),
  },
  providers: {
    targets: relate.many.poolTargets(),
    usage: relate.many.usageCounts(),
    prices: relate.many.modelPrices(),
  },
  modelPrices: {
    provider: relate.one.providers({ from: relate.modelPrices.providerId, to: relate.providers.id }),
  },
  pools: { targets: relate.many.poolTargets(), usage: relate.many.usageCounts() },
  poolTargets: {
    pool: relate.one.pools({ from: relate.poolTargets.poolId, to: relate.pools.id }),
    provider: relate.one.providers({ from: relate.poolTargets.providerId, to: relate.providers.id }),
  },
  usageCounts: {
    workspace: relate.one.workspaces({ from: relate.usageCounts.workspaceId, to: relate.workspaces.id }),
    provider: relate.one.providers({ from: relate.usageCounts.providerId, to: relate.providers.id }),
    agent: relate.one.agents({ from: relate.usageCounts.agentId, to: relate.agents.id }),
    pool: relate.one.pools({ from: relate.usageCounts.poolId, to: relate.pools.id }),
  },
  servers: {
    secrets: relate.many.serverSecrets(),
    workspaces: relate.many.workspaceServers(),
    activity: relate.many.activity(),
    agentGrants: relate.many.workspaceAgentServers(),
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
    // Stated, since a revision names an agent twice: the one it is of, and the one whose run saved it.
    revisions: relate.many.agentRevisions({ from: relate.agents.id, to: relate.agentRevisions.agentId }),
    liveRevision: relate.one.agentRevisions({ from: relate.agents.liveRevisionId, to: relate.agentRevisions.id }),
    workspaces: relate.many.workspaceAgents(),
    usage: relate.many.usageCounts(),
    runs: relate.many.runs(),
  },
  agentRevisions: {
    agent: relate.one.agents({ from: relate.agentRevisions.agentId, to: relate.agents.id }),
    creator: relate.one.users({ from: relate.agentRevisions.createdBy, to: relate.users.id }),
    savedByWorkspace: relate.one.workspaces({
      from: relate.agentRevisions.savedByWorkspaceId,
      to: relate.workspaces.id,
    }),
    savedByAgent: relate.one.agents({ from: relate.agentRevisions.savedByAgentId, to: relate.agents.id }),
    basedOn: relate.one.agentRevisions({ from: relate.agentRevisions.basedOnId, to: relate.agentRevisions.id }),
  },
  workspaceAgents: {
    workspace: relate.one.workspaces({ from: relate.workspaceAgents.workspaceId, to: relate.workspaces.id }),
    agent: relate.one.agents({ from: relate.workspaceAgents.agentId, to: relate.agents.id }),
    servers: relate.many.workspaceAgentServers(),
  },
  workspaceAgentServers: {
    workspaceAgent: relate.one.workspaceAgents({
      from: relate.workspaceAgentServers.workspaceAgentId,
      to: relate.workspaceAgents.id,
    }),
    server: relate.one.servers({ from: relate.workspaceAgentServers.serverId, to: relate.servers.id }),
  },
  runs: {
    workspace: relate.one.workspaces({ from: relate.runs.workspaceId, to: relate.workspaces.id }),
    agent: relate.one.agents({ from: relate.runs.agentId, to: relate.agents.id }),
    revision: relate.one.agentRevisions({ from: relate.runs.revisionId, to: relate.agentRevisions.id }),
    conversation: relate.one.conversations({ from: relate.runs.conversationId, to: relate.conversations.id }),
    // No foreign key: a call's activity is written a few seconds after it, and outlives its run's record.
    activity: relate.many.activity({ from: relate.runs.id, to: relate.activity.runId }),
  },
  conversations: {
    workspace: relate.one.workspaces({ from: relate.conversations.workspaceId, to: relate.workspaces.id }),
    agent: relate.one.agents({ from: relate.conversations.agentId, to: relate.agents.id }),
    runs: relate.many.runs(),
  },
  activity: {
    server: relate.one.servers({ from: relate.activity.serverId, to: relate.servers.id }),
    workspace: relate.one.workspaces({ from: relate.activity.workspaceId, to: relate.workspaces.id }),
    agent: relate.one.agents({ from: relate.activity.agentId, to: relate.agents.id }),
    run: relate.one.runs({ from: relate.activity.runId, to: relate.runs.id }),
  },
}));
