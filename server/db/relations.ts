import { defineRelations } from 'drizzle-orm';
import * as schema from './schema.ts';

/** Drizzle v2 relations. drizzle-graphql generates nested read fields from these. */
export const relations = defineRelations(schema, (relate) => ({
  workspaces: { keys: relate.many.workspaceKeys() },
  workspaceKeys: {
    workspace: relate.one.workspaces({ from: relate.workspaceKeys.workspaceId, to: relate.workspaces.id }),
    creator: relate.one.users({ from: relate.workspaceKeys.createdBy, to: relate.users.id }),
  },
}));
