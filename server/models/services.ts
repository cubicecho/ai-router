import type { DB } from '../db/client.ts';
import type { SnapshotHost } from '../db/snapshot.ts';
import { PoolBalancer } from './balancer.ts';
import { ModelCatalog } from './catalog.ts';
import { createForwarder, type Forwarder } from './forward.ts';
import { createOutboundFetch, type UpstreamFetch } from './outbound.ts';
import { createUsageRecorder, type UsageRecorder } from './usage.ts';

/** The models area's running parts, one set per process. */
export interface ModelServices {
  balancer: PoolBalancer;
  catalog: ModelCatalog;
  usage: UsageRecorder;
  forwarder: Forwarder;
}

/** What the models area is built from. */
export interface ModelServiceDeps {
  db: DB;
  snapshot: SnapshotHost;
  /**
   * How providers are reached.
   * @defaultValue `createOutboundFetch()`
   */
  fetch?: UpstreamFetch;
}

/**
 * Builds the models area's parts. Nothing starts: the usage recorder's timers are the caller's to start.
 *
 * @param deps - The database, the snapshot and how providers are reached.
 * @returns The parts.
 */
export function createModelServices({ db, snapshot, fetch = createOutboundFetch() }: ModelServiceDeps): ModelServices {
  const balancer = new PoolBalancer();
  const catalog = new ModelCatalog(fetch);
  const usage = createUsageRecorder(db);
  const forwarder = createForwarder({ snapshot, balancer, catalog, usage, fetch });
  return { balancer, catalog, usage, forwarder };
}
