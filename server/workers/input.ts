import { z } from 'zod';
import { nameSchema } from '../core/names.ts';
import { LOCAL_WORKER_NAME } from '../db/tables/workers.ts';

/** What making a worker takes: a router name, never the built-in worker's. */
export const workerInput = z.object({
  name: nameSchema('Name').refine((name) => name !== LOCAL_WORKER_NAME, {
    message: `"${LOCAL_WORKER_NAME}" is kept for the worker inside the router.`,
  }),
});
