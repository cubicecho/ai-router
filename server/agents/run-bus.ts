import type { RunEvent, RunEventInput, Runtime } from '@cubicecho/agent-core';

/**
 * A run's events while it runs, in memory, as agent-core's `RunEvent` unchanged. Phase 7 stores them as well.
 *
 * @remarks
 * It is agent-core's own bus, inside the runtime the runs use, so a test's runs and watchers never meet another's.
 */
export interface RunBus {
  /**
   * Records one event and hands it to the run's watchers.
   *
   * @param runId - The run.
   * @param input - What happened. The bus numbers and stamps it.
   * @returns The event as recorded.
   */
  publish(runId: string, input: RunEventInput): RunEvent;
  /**
   * Follows a run: what it has said so far, then what it says next, until its `done`.
   *
   * @param runId - The run.
   * @param [signal] - Stops following, for a watcher that leaves early.
   * @returns The events.
   */
  watch(runId: string, signal?: AbortSignal): AsyncGenerator<RunEvent>;
  /**
   * The events still held for a run, for a reader that wants them at once.
   *
   * @param runId - The run.
   * @returns Oldest first. Empty for a run the bus no longer holds.
   */
  history(runId: string): RunEvent[];
}

/**
 * Builds the run bus over a runtime's event bus.
 *
 * @param runtime - The agent-core runtime the runs use.
 * @returns The bus.
 */
export function createRunBus(runtime: Runtime): RunBus {
  return {
    publish: (runId, input) => runtime.emit(runId, input),
    watch: (runId, signal) => runtime.watch(runId, signal),
    history: (runId) => runtime.history(runId),
  };
}
