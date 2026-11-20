import type { AppPart } from '@cubicecho/agent-core';
import { AGENT_SPEC, upgradeSpec } from '@cubicecho/agent-core/spec';
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { isRecord } from '../core/is-record.ts';
import type { DB } from '../db/client.ts';
import { agentRevisions } from '../db/tables/agent-revisions.ts';
import { agents } from '../db/tables/agents.ts';
import { overridePolicies } from '../db/tables/override-policies.ts';
import { type RunResume, RunStatus, runs } from '../db/tables/runs.ts';
import { overridePolicyRulesSchema } from './policy.ts';

/**
 * The one-time upgrade of what the router keeps to agent-core 7: version 2 documents, policies without prompt
 * switches, and waiting runs that keep the app's system messages and parts. Each step finds only what is still old,
 * so running it again does nothing.
 */

/** The policy switches agent-core 7 removed: system messages and app parts are always taken now. */
const PROMPT_SWITCHES: readonly string[] = Object.freeze(['hostPrompt', 'taskPrompt']);

/** The name a waiting run's old task text is kept under, as one of the app's parts: written as `app_task`. */
const TASK_PART_NAME = 'task';

/** How the upgrade says what it did. */
export interface UpgradeLog {
  log(message: string): void;
  warn(message: string): void;
}

/**
 * Upgrades every revision that holds a version 1 document, with agent-core's `upgradeSpec`.
 *
 * @param db - The database.
 * @param log - Where each upgraded revision and its warnings are told.
 * @returns How many revisions were upgraded.
 */
async function upgradeRevisions(db: DB, log: UpgradeLog): Promise<number> {
  const old = await db
    .select({
      id: agentRevisions.id,
      number: agentRevisions.number,
      document: agentRevisions.document,
      warnings: agentRevisions.warnings,
      agentName: agents.name,
    })
    .from(agentRevisions)
    .innerJoin(agents, eq(agents.id, agentRevisions.agentId))
    .where(ne(sql`${agentRevisions.document}->>'spec'`, AGENT_SPEC));
  let count = 0;
  for (const revision of old) {
    const { document, upgraded, warnings } = upgradeSpec(revision.document);
    if (upgraded === false || isRecord(document) === false) {
      continue;
    }
    for (const warning of warnings) {
      log.warn(`[upgrade] agent "${revision.agentName}" revision ${revision.number}: ${warning}`);
    }
    await db
      .update(agentRevisions)
      .set({ document, warnings: [...revision.warnings, ...warnings] })
      .where(eq(agentRevisions.id, revision.id));
    count += 1;
  }
  return count;
}

/**
 * Takes the prompt switches out of every policy, and lists the agents whose policy refused system messages: they
 * take them now.
 *
 * @param db - The database.
 * @param log - Where each such agent is named, for someone to check.
 * @returns How many policies were changed.
 */
async function upgradePolicies(db: DB, log: UpgradeLog): Promise<number> {
  const policies = await db.select().from(overridePolicies);
  let count = 0;
  for (const policy of policies) {
    const rules: Record<string, unknown> = { ...policy.rules };
    const hasSwitches = PROMPT_SWITCHES.some((name) => name in rules);
    if (hasSwitches === false) {
      continue;
    }
    if (rules.hostPrompt === false) {
      const using = await db.select({ name: agents.name }).from(agents).where(eq(agents.overridePolicyId, policy.id));
      for (const agent of using) {
        log.warn(
          `[upgrade] agent "${agent.name}" uses override policy "${policy.name}", which refused system messages. Every agent takes them now, after its own parts: check that it should.`,
        );
      }
    }
    // The schema keeps only the rules it names, so the switches are left behind.
    const parsed = overridePolicyRulesSchema.safeParse(rules);
    if (parsed.success === false) {
      log.warn(`[upgrade] override policy "${policy.name}" has rules that don't read, so it is left as it is.`);
      continue;
    }
    await db.update(overridePolicies).set({ rules: parsed.data }).where(eq(overridePolicies.id, policy.id));
    count += 1;
  }
  return count;
}

/**
 * Rewrites each waiting run's kept layers: its host text as the app's system messages, and its task text as one of
 * the app's parts, so it resumes with the prompt it started with as near as version 2 can say it.
 *
 * @param db - The database.
 * @returns How many runs were changed.
 */
async function upgradeWaitingRuns(db: DB): Promise<number> {
  const waiting = await db
    .select({ id: runs.id, resume: runs.resume })
    .from(runs)
    .where(and(eq(runs.status, RunStatus.Waiting), isNotNull(runs.resume)));
  let count = 0;
  for (const { id, resume } of waiting) {
    const stored: Record<string, unknown> = { ...resume };
    const isOld = 'hostText' in stored || 'taskText' in stored;
    if (resume === null || isOld === false) {
      continue;
    }
    const { hostText, taskText } = stored;
    const appParts: AppPart[] | null =
      typeof taskText === 'string' ? [{ role: 'system', name: TASK_PART_NAME, content: taskText }] : null;
    const upgraded: RunResume = {
      messages: resume.messages,
      handedBack: resume.handedBack,
      appTools: resume.appTools,
      loaded: resume.loaded,
      systemText: typeof hostText === 'string' ? hostText : null,
      appParts,
      servers: resume.servers,
      sampling: resume.sampling,
    };
    await db.update(runs).set({ resume: upgraded }).where(eq(runs.id, id));
    count += 1;
  }
  return count;
}

/**
 * Upgrades what the router keeps to agent-core 7, once, at boot: after the migrations, before the snapshot is read.
 *
 * @param db - The database, claimed and migrated.
 * @param [log] - Where it says what it did.
 */
export async function upgradeStored(db: DB, log: UpgradeLog = console): Promise<void> {
  const revisions = await upgradeRevisions(db, log);
  const policies = await upgradePolicies(db, log);
  const waiting = await upgradeWaitingRuns(db);
  const changed = revisions + policies + waiting;
  if (changed > 0) {
    log.log(
      `[upgrade] to ${AGENT_SPEC}: ${revisions} revisions, ${policies} override policies and ${waiting} waiting runs`,
    );
  }
}
