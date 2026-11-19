import { isDeepStrictEqual } from 'node:util';
import { splitToolName } from '../tools/naming.ts';
import type { AppTool } from './request.ts';
import { type RunTool, withValidChars } from './tool-names.ts';

/** One of the agent's tools, as far as pruning compares it with an app's. */
export interface AgentToolShape extends RunTool {
  /** Its input schema, as the model is given it. */
  parameters: Record<string, unknown>;
}

/** An app tool left out of a run, because one of the agent's own tools answers in its place. */
export interface PrunedAppTool {
  /** The app tool's name. */
  name: string;
  /** The agent's tool that answers instead, by the function name the model sees. */
  agentTool: string;
  /** True when it matched under another server's name, false when the names are the same. */
  acrossServers: boolean;
}

/** What pruning an app's tools gave. */
export interface PrunedAppTools {
  /** The app tools the run hands back, in the order sent. */
  kept: AppTool[];
  pruned: PrunedAppTool[];
}

/**
 * Finds the agent's tool that is an app tool under another server's name.
 *
 * @param appTool - The app's tool.
 * @param agentTools - The agent's tools, by function name.
 * @returns The function name of the first agent tool whose own name is the part of the app tool's name after its
 * first `__`, with an input schema equal to the app tool's, or null when none is.
 */
function sameToolElsewhere(appTool: AppTool, agentTools: ReadonlyMap<string, AgentToolShape>): string | null {
  const split = splitToolName(appTool.function.name);
  if (split === null) {
    return null;
  }
  for (const [name, tool] of agentTools) {
    const isSameTool = withValidChars(tool.tool) === split.tool;
    if (isSameTool && isDeepStrictEqual(appTool.function.parameters, tool.parameters)) {
      return name;
    }
  }
  return null;
}

/**
 * Leaves out the app tools that duplicate the agent's own, so the agent's server answers them and none is handed back.
 *
 * @param appTools - The app's tools, as the request sent them.
 * @param agentTools - The agent's tools, by the function name the model sees.
 * @param acrossServers - Whether to also leave out the same tool under another server's name: the router setting
 * `pruneAppToolsAcrossServers`.
 * @returns The tools kept, and what was left out.
 *
 * @remarks
 * An app tool with the name of one of the agent's tools is always left out: a name can only be the same when the
 * server and the tool are. One whose name differs only before its first `__`, with an equal input schema, is left out
 * only when `acrossServers` is on, since two servers' tools may share a name and a schema and still differ.
 */
export function pruneAppTools(
  appTools: readonly AppTool[],
  agentTools: ReadonlyMap<string, AgentToolShape>,
  acrossServers: boolean,
): PrunedAppTools {
  const kept: AppTool[] = [];
  const pruned: PrunedAppTool[] = [];
  for (const appTool of appTools) {
    const { name } = appTool.function;
    if (agentTools.has(name)) {
      pruned.push({ name, agentTool: name, acrossServers: false });
      continue;
    }
    const elsewhere = acrossServers ? sameToolElsewhere(appTool, agentTools) : null;
    if (elsewhere === null) {
      kept.push(appTool);
      continue;
    }
    pruned.push({ name, agentTool: elsewhere, acrossServers: true });
  }
  return { kept, pruned };
}
