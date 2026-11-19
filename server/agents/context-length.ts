import type { AgentSpec } from '@cubicecho/agent-core/spec';
import type { Snapshot } from '../db/snapshot.ts';
import { contextLengthOf, type ModelCatalog } from '../models/catalog.ts';
import { splitModelId } from '../models/naming.ts';
import { agentLayer, UnreadableAgentError } from './layers.ts';

/** One model an agent's model id may reach: a provider's, by its id there. */
interface ReachedModel {
  providerName: string;
  model: string;
}

/**
 * Finds the models an agent's model id reaches.
 *
 * @param model - The id from the document: `<provider>/<model>`, or a pool's name.
 * @param snapshot - The router's pools.
 * @returns The one model, or the pool's targets. Empty for a pool the router doesn't have.
 */
function reachedModels(model: string, snapshot: Snapshot): readonly ReachedModel[] {
  const split = splitModelId(model);
  if (split !== null) {
    return [split];
  }
  return snapshot.pools.get(model)?.targets ?? [];
}

/**
 * Reads what a provider's listing says one model reads.
 *
 * @param reached - The model.
 * @param snapshot - The router's providers.
 * @param catalog - The providers' listings.
 * @returns Its context window in tokens, or null when the provider is unknown or off, its listing is late, or it
 * states none.
 */
async function listedContextLength(
  reached: ReachedModel,
  snapshot: Snapshot,
  catalog: ModelCatalog,
): Promise<number | null> {
  const provider = snapshot.providers.get(reached.providerName);
  if (provider === undefined || provider.enabled === false) {
    return null;
  }
  const models = await catalog.listWithin(provider);
  const listed = models?.find((entry) => entry.id === reached.model);
  return listed === undefined ? null : contextLengthOf(listed);
}

/**
 * Works out how many tokens an agent's model reads, for its `/v1/models` entry.
 *
 * @param agentName - The agent, for reading its document.
 * @param document - Its live revision's document.
 * @param snapshot - The router's providers and pools.
 * @param catalog - The providers' listings.
 * @returns The document's `model.contextLength` when it states one above zero. Otherwise what the providers list for
 * its model, the smallest across a pool's targets that state one. Null when nothing says, or the agent calls an
 * endpoint of its own.
 */
export async function agentContextLength(
  agentName: string,
  document: Readonly<Record<string, unknown>>,
  snapshot: Snapshot,
  catalog: ModelCatalog,
): Promise<number | null> {
  let spec: AgentSpec;
  try {
    spec = agentLayer(agentName, document);
  } catch (error) {
    if (error instanceof UnreadableAgentError) {
      return null;
    }
    throw error;
  }
  const stated = spec.model?.contextLength;
  if (stated !== undefined && stated > 0) {
    return stated;
  }
  const model = spec.model?.model;
  const hasOwnEndpoint = typeof spec.endpoint?.baseUrl === 'string' && spec.endpoint.baseUrl !== '';
  if (hasOwnEndpoint || model === undefined || model === '') {
    return null;
  }
  const listed = await Promise.all(
    reachedModels(model, snapshot).map((reached) => listedContextLength(reached, snapshot, catalog)),
  );
  const known = listed.filter((value) => value !== null);
  return known.length === 0 ? null : Math.min(...known);
}
