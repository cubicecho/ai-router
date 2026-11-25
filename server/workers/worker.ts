import type { RunAssignment, RunOutcome, RunPorts } from '../runner/assignment.ts';

/** Where a run's agent loop executes. The router keeps the run's record and lends the worker its ports. */
export interface RunWorker {
  /**
   * Runs one stretch of a run's loop.
   *
   * @param assignment - The stretch.
   * @param ports - The router's side of it: model calls, tool calls, events and the run's signal.
   * @returns How the loop ended. Never rejects: a failure is a failed outcome.
   */
  execute(assignment: RunAssignment, ports: RunPorts): Promise<RunOutcome>;
}
