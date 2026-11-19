import { type Action, Actions, createGraphQLAbility, type GraphQLAbility } from '@vantreeseba/graphql-casl';
import { AdminRole } from '../core/admin-roles.ts';
import { CALLER_RUN, CALLER_USER, type Caller } from '../core/context.ts';

/**
 * What the abilities talk about: the GraphQL types an admin-server role reaches. `ServerInstance` stands for what
 * runs on a server, since casl's actions are fixed: operating a server is updating its instance.
 */
export const Subject = {
  Agent: 'Agent',
  AgentRevision: 'AgentRevision',
  Provider: 'Provider',
  Pool: 'Pool',
  Server: 'Server',
  Registry: 'Registry',
  ServerInstance: 'ServerInstance',
  Run: 'Run',
} as const;
export type Subject = (typeof Subject)[keyof typeof Subject];

/** The subject map the ability is typed by. Checks are on bare subjects, with no conditions. */
type Subjects = Record<Subject, Record<string, unknown>>;

/** A caller's ability. */
export type RouterAbility = GraphQLAbility<Subjects>;

/** What one role grants: actions on subjects. Listed, never casl's `manage`, so a new action is shut until named. */
type Grant = readonly [readonly Action[], readonly Subject[]];

const { read, create, update, delete: remove } = Actions;
const EVERY_ACTION: readonly Action[] = [read, create, update, remove];

/** What each role grants. A manage role reads its own area. */
const ROLE_GRANTS: Readonly<Record<AdminRole, readonly Grant[]>> = {
  [AdminRole.AgentsRead]: [[[read], [Subject.Agent, Subject.AgentRevision]]],
  // Delete is a draft's discard, which the resolver allows only for the run's own drafts.
  [AdminRole.AgentsManage]: [
    [[read, create, update], [Subject.Agent]],
    [[read, create, remove], [Subject.AgentRevision]],
  ],
  [AdminRole.ModelsRead]: [[[read], [Subject.Provider, Subject.Pool]]],
  [AdminRole.ModelsManage]: [[EVERY_ACTION, [Subject.Provider, Subject.Pool]]],
  [AdminRole.ServersRead]: [[[read], [Subject.Server, Subject.Registry]]],
  [AdminRole.ServersManage]: [[EVERY_ACTION, [Subject.Server, Subject.Registry]]],
  [AdminRole.ServersOperate]: [
    [[read], [Subject.Server]],
    [[update], [Subject.ServerInstance]],
  ],
  [AdminRole.RunsRead]: [[[read], [Subject.Run]]],
};

/**
 * Builds what a caller may do to the subjects.
 *
 * @param caller - The caller, or null for nobody.
 * @returns A person may do everything; a run what its roles grant; a workspace key and nobody nothing.
 */
export function abilityFor(caller: Caller | null): RouterAbility {
  if (caller?.kind === CALLER_RUN) {
    return abilityForRoles(caller.roles);
  }
  const { can, build } = createGraphQLAbility<Subjects>();
  if (caller?.kind === CALLER_USER) {
    can([...EVERY_ACTION], Object.values(Subject));
  }
  return build();
}

/**
 * Builds what an agent run may do with a set of roles.
 *
 * @param roles - The roles its workspace's entry for `ai-router` grants.
 * @returns What they add up to. No roles reach nothing.
 */
export function abilityForRoles(roles: readonly AdminRole[]): RouterAbility {
  const { can, build } = createGraphQLAbility<Subjects>();
  for (const role of roles) {
    for (const [actions, subjects] of ROLE_GRANTS[role]) {
      can([...actions], [...subjects]);
    }
  }
  return build();
}

/** The action and subject a root field needs. */
export interface FieldGrant {
  action: Action;
  subject: Subject;
}

/**
 * Builds the four read fields drizzle-graphql generates for a table.
 *
 * @param single - The single-row field.
 * @param plural - The list field.
 * @param subject - What reading them needs.
 * @returns The fields, keyed by name.
 */
function tableReads(single: string, plural: string, subject: Subject): Record<string, FieldGrant> {
  const grant = { action: read, subject };
  return { [single]: grant, [plural]: grant, [`${plural}Aggregate`]: grant, [`${plural}GroupBy`]: grant };
}

/**
 * The root fields an admin-server role can reach, and what each needs. A root field missing here is for people
 * only, so a field a new table adds stays shut to runs. The admin server lists a run only the fields its ability
 * allows.
 */
export const FIELD_GRANTS = {
  Query: {
    ...tableReads('agent', 'agents', Subject.Agent),
    ...tableReads('agentRevision', 'agentRevisions', Subject.AgentRevision),
    checkAgent: { action: read, subject: Subject.Agent },
    ...tableReads('provider', 'providers', Subject.Provider),
    ...tableReads('modelPrice', 'modelPrices', Subject.Provider),
    ...tableReads('pool', 'pools', Subject.Pool),
    ...tableReads('poolTarget', 'poolTargets', Subject.Pool),
    providerModels: { action: read, subject: Subject.Provider },
    poolLoad: { action: read, subject: Subject.Pool },
    ...tableReads('server', 'servers', Subject.Server),
    ...tableReads('registry', 'registries', Subject.Registry),
    serverTools: { action: read, subject: Subject.Server },
    serverDefaults: { action: read, subject: Subject.Server },
    registryServers: { action: read, subject: Subject.Registry },
    ...tableReads('run', 'runs', Subject.Run),
  },
  Mutation: {
    createAgent: { action: create, subject: Subject.Agent },
    saveAgent: { action: create, subject: Subject.AgentRevision },
    // The resolver lets a run discard only the drafts its own agent saved for its workspace.
    discardRevision: { action: remove, subject: Subject.AgentRevision },
    createProvider: { action: create, subject: Subject.Provider },
    updateProvider: { action: update, subject: Subject.Provider },
    deleteProvider: { action: remove, subject: Subject.Provider },
    createPool: { action: create, subject: Subject.Pool },
    updatePool: { action: update, subject: Subject.Pool },
    deletePool: { action: remove, subject: Subject.Pool },
    setPoolTargets: { action: update, subject: Subject.Pool },
    createRegistry: { action: create, subject: Subject.Registry },
    updateRegistry: { action: update, subject: Subject.Registry },
    deleteRegistry: { action: remove, subject: Subject.Registry },
    installServer: { action: create, subject: Subject.Server },
    updateServer: { action: update, subject: Subject.Server },
    deleteServer: { action: remove, subject: Subject.Server },
    restartServer: { action: update, subject: Subject.ServerInstance },
    tryServerTool: { action: update, subject: Subject.ServerInstance },
    startServerLogin: { action: update, subject: Subject.ServerInstance },
    signOutServer: { action: update, subject: Subject.ServerInstance },
  },
} as const satisfies Record<'Query' | 'Mutation', Record<string, FieldGrant>>;

/**
 * Whether a caller's ability reaches a root field.
 *
 * @param ability - The caller's ability.
 * @param operation - `Query` or `Mutation`.
 * @param field - The field's name.
 * @returns false for a field no role reaches.
 */
export function canReachField(ability: RouterAbility, operation: keyof typeof FIELD_GRANTS, field: string): boolean {
  const grants: Readonly<Record<string, FieldGrant>> = FIELD_GRANTS[operation];
  const grant = grants[field];
  return grant !== undefined && ability.can(grant.action, grant.subject);
}
