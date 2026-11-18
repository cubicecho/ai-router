import type { RunService } from '../agents/run.ts';
import type { AuthHost } from '../auth/auth-host.ts';
import type { Auth } from '../auth/better-auth.ts';
import type { RateLimiter } from '../auth/rate-limit.ts';
import type { DB } from '../db/client.ts';
import type { SnapshotHost } from '../db/snapshot.ts';
import type { Role } from '../db/tables/users.ts';
import type { ModelServices } from '../models/services.ts';
import type { ToolServices } from '../tools/api.ts';

/** What `Context.ip` holds when the socket reports no address. One shared budget, not none. */
export const UNKNOWN_IP = 'unknown';

/** A person, on a session. */
export const CALLER_USER = 'user' as const;
/** An app, on a workspace key. */
export const CALLER_WORKSPACE = 'workspace' as const;

/** A person signed in to the UI. Sees everything enabled; only an admin sees secrets, settings and roles. */
export interface UserCaller {
  kind: typeof CALLER_USER;
  userId: string;
  role: Role;
}

/** An app calling with a workspace key. Sees what its workspace grants, and never /graphql. */
export interface WorkspaceCaller {
  kind: typeof CALLER_WORKSPACE;
  workspaceId: string;
  keyId: string;
}

/** Who a request is from, read once from its credential. */
export type Caller = UserCaller | WorkspaceCaller;

/** What every request's context carries, whoever the caller is. */
export interface ContextDeps {
  db: DB;
  /** Where the current better-auth instance is. Pairing a provider rebuilds it. */
  authHost: AuthHost;
  /** What the gateways route by, and keys are checked against. */
  snapshot: SnapshotHost;
  /** Sign-in throttle. The sign-in mutations call it. */
  limiter: RateLimiter;
  /** The models area: providers' model lists, pool load, forwarding and usage. */
  models: ModelServices;
  /** The tools area: installing, instances, registries and server logins. */
  tools: ToolServices;
  /** Agent runs, and the bus their live events are on. */
  runs: RunService;
}

/** What every resolver, generated or hand-written, is handed. */
export interface Context extends ContextDeps {
  /** The better-auth instance for this request; the auth resolvers call `auth.api.*`. */
  auth: Auth;
  /** null for nobody, which permissions refuse everywhere but signing in. */
  caller: Caller | null;
  /** The request's headers. better-auth reads the session from them. */
  headers: Headers;
  /** The client's address as Express resolved it under `TRUST_PROXY`. Never an identity. */
  ip: string;
  /** The fetch request, which Yoga adds. Its signal ends a subscription whose client left. Absent in tests. */
  request?: Request;
}
