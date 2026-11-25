import { eq } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import { requireUser } from '../auth/caller.ts';
import { mintKey, WORKER_KEY_PREFIX } from '../auth/keys.ts';
import type { Context } from '../core/context.ts';
import { badInput, conflict, notFound } from '../core/errors.ts';
import { parseOrThrow } from '../core/validation.ts';
import type { Transaction } from '../db/client.ts';
import { LOCAL_WORKER_NAME, type WorkerRow, workers } from '../db/tables/workers.ts';
import { workspaces } from '../db/tables/workspaces.ts';
import { objectType } from '../graphql/object-type.ts';
import { workerInput } from './input.ts';

const WORKERS_SDL = parse(`
  "A worker with a new key. The secret is in this answer and nowhere else, so show it to the person now."
  type CreatedWorkerKey {
    worker: Worker!
    "The whole key, for the worker to dial in with."
    secret: String!
  }

  extend type Mutation {
    "Adds a remote worker, with its key. No workspace runs on it until one is set to."
    createWorker(name: String!): CreatedWorkerKey!
    "Gives a worker a new key. The old one stops working at once. The local worker has no key."
    rotateWorkerKey(id: UUID!): CreatedWorkerKey!
    """
    Removes a worker. Refused while a workspace runs on it, and for the local worker. Its runs stay, naming none.
    True when there was such a worker.
    """
    deleteWorker(id: UUID!): Boolean!
  }
`);

/** What a person is told when they reach for the built-in worker's key, or try to delete it. */
const LOCAL_KEPT = `"${LOCAL_WORKER_NAME}" runs inside the router: it has no key, and it can't be deleted.`;

/**
 * Reads a remote worker for a change, refusing the built-in one.
 *
 * @param tx - The change's transaction.
 * @param id - The worker.
 * @returns Its row, or undefined for a worker that doesn't exist.
 * @throws BAD_USER_INPUT for `local`.
 */
async function remoteWorker(tx: Transaction, id: string): Promise<WorkerRow | undefined> {
  const [worker] = await tx.select().from(workers).where(eq(workers.id, id));
  if (worker?.name === LOCAL_WORKER_NAME) {
    throw badInput(LOCAL_KEPT);
  }
  return worker;
}

/**
 * Adds the worker fields CRUD can't express: making a worker with its key, rotating the key, and removing a worker.
 * Workers have no generated writes, so `local` is never renamed or deleted.
 *
 * @param schema - Schema to extend.
 * @returns The extended schema.
 */
export function applyWorkersExtension(schema: GraphQLSchema): GraphQLSchema {
  const extended = extendSchema(schema, WORKERS_SDL);
  const mutations = objectType(extended, 'Mutation').getFields();

  mutations.createWorker.resolve = async (_parent: unknown, args: { name: string }, ctx: Context) => {
    const { userId } = requireUser(ctx.caller);
    const { name } = parseOrThrow(workerInput, args);
    const { secret, hash, start } = mintKey(WORKER_KEY_PREFIX);
    const worker = await ctx.db.transaction(async (tx) => {
      const [taken] = await tx.select({ id: workers.id }).from(workers).where(eq(workers.name, name));
      if (taken !== undefined) {
        throw badInput('A worker with that name already exists.');
      }
      const [created] = await tx
        .insert(workers)
        .values({ name, keyHash: hash, keyPrefix: start, createdBy: userId })
        .returning();
      return created;
    });
    // Before answering, so the worker can dial in at once.
    await ctx.snapshot.rebuild();
    return { worker, secret };
  };

  mutations.rotateWorkerKey.resolve = async (_parent: unknown, args: { id: string }, ctx: Context) => {
    requireUser(ctx.caller);
    const { secret, hash, start } = mintKey(WORKER_KEY_PREFIX);
    const worker = await ctx.db.transaction(async (tx) => {
      const existing = await remoteWorker(tx, args.id);
      if (existing === undefined) {
        throw notFound('Worker not found.');
      }
      const [rotated] = await tx
        .update(workers)
        .set({ keyHash: hash, keyPrefix: start })
        .where(eq(workers.id, args.id))
        .returning();
      return rotated;
    });
    // Before answering, so the old key is refused from the next request.
    await ctx.snapshot.rebuild();
    return { worker, secret };
  };

  mutations.deleteWorker.resolve = async (_parent: unknown, args: { id: string }, ctx: Context) => {
    requireUser(ctx.caller);
    const deleted = await ctx.db.transaction(async (tx) => {
      const existing = await remoteWorker(tx, args.id);
      if (existing === undefined) {
        return false;
      }
      const [placed] = await tx
        .select({ slug: workspaces.slug })
        .from(workspaces)
        .where(eq(workspaces.workerId, args.id))
        .limit(1);
      if (placed !== undefined) {
        throw conflict(`Workspace "${placed.slug}" runs on this worker. Move it to another worker first.`);
      }
      await tx.delete(workers).where(eq(workers.id, args.id));
      return true;
    });
    await ctx.snapshot.rebuild();
    return deleted;
  };

  return extended;
}
