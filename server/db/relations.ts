import { defineRelations } from 'drizzle-orm';
import * as schema from './schema.ts';

/** Drizzle v2 relations. drizzle-graphql generates nested read fields from these. */
export const relations = defineRelations(schema, (relate) => ({
  workspaces: { keys: relate.many.workspaceKeys(), usage: relate.many.usageCounts() },
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
  },
}));
