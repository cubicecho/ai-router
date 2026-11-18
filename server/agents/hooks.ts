import type { OnWriteConfig } from '@vantreeseba/drizzle-graphql';
import { rebuildAfterCommit } from '../graphql/write-guards.ts';

/**
 * Snapshot hooks for the agents tables CRUD writes: deleting an agent, and which workspaces may run
 * which. An agent is created and saved by `createAgent` and `saveAgent`.
 */
export const agentWriteHooks: OnWriteConfig = {
  agents: {
    delete: { after: rebuildAfterCommit },
  },
  workspaceAgents: {
    insert: { after: rebuildAfterCommit },
    update: { after: rebuildAfterCommit },
    delete: { after: rebuildAfterCommit },
  },
};
