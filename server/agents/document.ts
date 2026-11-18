import { AGENT_SPEC, type AgentSpec, exportSpec, parseSpec } from '@cubicecho/agent-core/spec';
import { AGENT_CONFIG_DEFAULTS } from '../core/defaults.ts';
import { isRecord } from '../core/is-record.ts';
import { nameSchema } from '../core/names.ts';
import type { Snapshot } from '../db/snapshot.ts';
import { splitModelId } from '../models/naming.ts';

/** The prompt part ids the router writes itself: the app's instructions and a scheduled job's. */
export const RESERVED_PART_IDS: readonly string[] = Object.freeze(['host', 'task']);

/** What a document check found. */
export interface DocumentCheck {
  /** Why it can't be saved. Empty when it can. */
  errors: string[];
  /** What is worth a person's attention. Never a reason to refuse. */
  warnings: string[];
  /** The document to store: as received, but for bundled servers' env and headers. Null when refused. */
  stored: Record<string, unknown> | null;
  /** The agent's name, from the document's `id`. Null when it has none. */
  name: string | null;
}

/**
 * Whether a value is an agent document, as far as its declaration goes.
 *
 * @param value - Anything.
 * @returns true for an object that declares `cubicecho.agent/1`.
 */
function isAgentDocument(value: unknown): value is AgentSpec {
  return isRecord(value) && value.spec === AGENT_SPEC;
}

/**
 * Says where a model id goes, if nowhere it can.
 *
 * @param model - A model id from the document.
 * @param where - Where in the document, for the message.
 * @param snapshot - The router's providers and pools.
 * @returns A warning, or null when the id names a provider or pool the router has.
 */
function modelWarning(model: string, where: string, snapshot: Snapshot): string | null {
  const split = splitModelId(model);
  if (split === null) {
    return snapshot.pools.has(model) ? null : `${where}: no pool is named "${model}".`;
  }
  return snapshot.providers.has(split.providerName) ? null : `${where}: no provider is named "${split.providerName}".`;
}

/**
 * The router's own warnings about a document that parsed: names it uses that the router doesn't have.
 *
 * @param spec - The parsed document.
 * @param snapshot - The router's providers, pools and servers.
 * @returns The warnings, in document order.
 */
function routerWarnings(spec: AgentSpec, snapshot: Snapshot): string[] {
  const warnings: string[] = [];
  const hasOwnEndpoint = typeof spec.endpoint?.baseUrl === 'string' && spec.endpoint.baseUrl !== '';
  if (hasOwnEndpoint) {
    warnings.push("endpoint.baseUrl: the agent calls that address directly, with no key, not the router's models.");
  }
  const model = spec.model?.model;
  if (hasOwnEndpoint === false) {
    if (typeof model === 'string' && model !== '') {
      const warning = modelWarning(model, 'model.model', snapshot);
      if (warning !== null) {
        warnings.push(warning);
      }
    } else {
      warnings.push('model.model: no model is named, so the agent cannot run.');
    }
    for (const [task, settings] of Object.entries(spec.tasks ?? {})) {
      const taskHasEndpoint = typeof settings.endpoint?.baseUrl === 'string' && settings.endpoint.baseUrl !== '';
      // An empty model turns the task off.
      const warning =
        taskHasEndpoint === false && typeof settings.model === 'string' && settings.model !== ''
          ? modelWarning(settings.model, `tasks.${task}.model`, snapshot)
          : null;
      if (warning !== null) {
        warnings.push(warning);
      }
    }
  }
  const servers = spec.tools?.servers;
  if (servers === undefined) {
    warnings.push('tools.servers: absent means every server the router has, now and later.');
  } else {
    for (const server of servers) {
      if (snapshot.servers.has(server) === false) {
        warnings.push(`tools.servers: no server is named "${server}".`);
      }
    }
  }
  return warnings;
}

/**
 * Checks a document before it is saved: agent-core's rules, then the router's.
 *
 * @param document - What was sent, as parsed JSON.
 * @param snapshot - The router's providers, pools and servers, for warnings about names it lacks.
 * @param [expectedName] - The agent's name, when saving a new revision of one: the document's `id` must match it.
 * @returns The errors, the warnings, and what to store.
 *
 * @remarks
 * Hard errors are agent-core's four, plus the router's: a document too large, an `id` that breaks the name rule
 * or doesn't match the agent, and a prompt part using a reserved id. A bundled server's env and headers are where
 * its credentials live, and every user can read a document, so they are taken out with a warning.
 */
export function checkDocument(document: unknown, snapshot: Snapshot, expectedName?: string): DocumentCheck {
  const refused = (errors: string[], warnings: string[] = []): DocumentCheck => ({
    errors,
    warnings,
    stored: null,
    name: null,
  });
  const size = Buffer.byteLength(JSON.stringify(document) ?? '', 'utf8');
  if (size > AGENT_CONFIG_DEFAULTS.maxDocumentBytes) {
    return refused([`The document is ${size} bytes; at most ${AGENT_CONFIG_DEFAULTS.maxDocumentBytes} are kept.`]);
  }
  // Nothing an agent requires is understood here yet, so a `requires` entry refuses it.
  const parsed = parseSpec(document, { understands: [] });
  if (parsed.spec === null || isAgentDocument(document) === false) {
    return refused(parsed.errors, parsed.warnings);
  }
  const errors: string[] = [];
  const name = typeof document.id === 'string' ? document.id : null;
  if (name === null) {
    errors.push('id: an agent needs an id, its name in the router.');
  } else {
    const checked = nameSchema('id').safeParse(name);
    if (checked.success === false) {
      errors.push(`id: ${checked.error.issues[0]?.message ?? 'not a valid name.'}`);
    } else if (expectedName !== undefined && name !== expectedName) {
      errors.push(`id: this is agent "${expectedName}"; a document for "${name}" can't be saved to it.`);
    }
  }
  for (const part of parsed.spec.prompt ?? []) {
    if (RESERVED_PART_IDS.includes(part.id)) {
      errors.push(`prompt: the part id "${part.id}" is kept for the router's own ${part.id} part.`);
    }
  }
  if (errors.length > 0) {
    return refused(errors, parsed.warnings);
  }
  const hadBundleSecrets = (document.bundle?.mcpServers ?? []).some(
    (server) => isRecord(server) && (server.env !== undefined || server.headers !== undefined),
  );
  const warnings = [...parsed.warnings, ...routerWarnings(parsed.spec, snapshot)];
  if (hadBundleSecrets) {
    warnings.push(
      "bundle.mcpServers: their env and headers aren't kept. Add the server to the router and set its secrets there.",
    );
  }
  return { errors: [], warnings, stored: { ...exportSpec(document) }, name };
}
