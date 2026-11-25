import {
  failedRun,
  type RunEventInput,
  RunEventKind,
  type Runtime,
  ToolDiscovery,
  type ToolDispatch,
} from '@cubicecho/agent-core';
import { errorMessage } from '../core/errors.ts';
import {
  type RunAssignment,
  type RunOutcome,
  type RunPorts,
  TOOL_ORIGIN_LOCAL,
  type ToolTarget,
} from './assignment.ts';
import { withRouterFetch } from './model-fetch.ts';

/**
 * What the transcript holds for a handed-back call until the app answers it. A resume replaces it; the model never
 * reads it.
 */
const HANDED_BACK = '(handed back to the app)';
/** Why the loop stopped at an app tool, as its `end` says it. */
const HANDED_BACK_REASON = 'handed back to the app';

/**
 * Finds what answers a tool the model called.
 *
 * @param targets - The run's tools, by function name.
 * @param name - The name the model called.
 * @returns The target, or undefined for a name the run has no tool by.
 */
function targetOf(targets: Readonly<Record<string, ToolTarget>>, name: string): ToolTarget | undefined {
  return Object.hasOwn(targets, name) ? targets[name] : undefined;
}

/**
 * Runs one stretch of a run's agent loop: to its answer, or until the model calls an app tool.
 *
 * @param assignment - The stretch.
 * @param ports - What the router lends it: model calls, tool calls, events and the run's signal.
 * @param runtime - agent-core's runtime, whose caches the loop uses.
 * @returns How the loop ended. Never rejects: a failure is a failed outcome.
 *
 * @remarks
 * Each app tool call ends the loop with a stand-in answer, which the app replaces when it resumes the run, so the
 * stand-in's result is never published.
 */
export async function executeRun(
  assignment: RunAssignment,
  ports: RunPorts,
  runtime: Pick<Runtime, 'runAgentLoop'>,
): Promise<RunOutcome> {
  const { runId, config, targets } = assignment;
  const appNames = new Set(assignment.appTools.map((tool) => tool.function.name));
  /** The loop ids of the calls handed back, in the order they were made. */
  const handedBack: string[] = [];
  const onEvent = (event: RunEventInput): void => {
    const isStandIn =
      event.kind === RunEventKind.ToolResult &&
      event.id !== undefined &&
      appNames.has(event.name ?? '') &&
      handedBack.includes(event.id);
    if (isStandIn) {
      return;
    }
    ports.publish(event);
  };
  const dispatch: ToolDispatch = async (call, callSignal) => {
    if (appNames.has(call.name)) {
      handedBack.push(call.id);
      return { text: HANDED_BACK, end: { reason: HANDED_BACK_REASON } };
    }
    const target = targetOf(targets, call.name);
    if (target === undefined) {
      throw new Error(`This run has no tool named "${call.name}".`);
    }
    const options = { call: { id: call.id, name: call.name }, signal: callSignal ?? ports.signal };
    if (target.origin === TOOL_ORIGIN_LOCAL) {
      if (ports.callLocalTool === undefined) {
        throw new Error(`This worker has no tool named "${target.tool}".`);
      }
      return ports.callLocalTool(target.tool, call.args, options);
    }
    return ports.callRouterTool(target.server, target.tool, call.args, options);
  };
  const isEager = config.toolDiscovery === ToolDiscovery.Eager;
  try {
    const result = await runtime.runAgentLoop({
      config: withRouterFetch(config, ports.modelFetch),
      systemPrompt: assignment.prompt,
      messages: assignment.messages,
      tools: assignment.tools,
      hostTools: assignment.appTools,
      loaded: assignment.loaded,
      ...(isEager ? {} : { catalog: assignment.catalog }),
      dispatch,
      // Every app tool call is handed back, a repeat included: only the app knows what it does.
      dedupeToolCalls: (call) => appNames.has(call.name) === false,
      signal: ports.signal,
      session: runId,
      onEvent,
    });
    return {
      ok: true,
      messages: result.messages,
      usage: result.usage,
      loaded: result.loaded,
      finishReason: result.turn.finishReason,
      handedBack,
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error), usage: failedRun(error)?.usage };
  }
}
