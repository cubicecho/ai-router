// Every value someone might tune in the worker program, as plain data. Nothing here computes, reads the
// environment or imports.

/** Settings for the workdir server, which gives each run a checkout per repo. */
export interface WorkdirSettings {
  /** How long one `git clone` may take before it is killed. */
  cloneTimeoutMs: number;
  /** How long one quick git command (reading a checkout's branch or HEAD) may take. */
  gitCommandTimeoutMs: number;
  /** Most entries one `list_dir` answer holds. Past it the answer says it was truncated. */
  maxEntries: number;
  /** Deepest `list_dir` goes below the directory it lists. 1 lists only the directory's own entries. */
  maxDepth: number;
}

export const WORKDIR_DEFAULTS: Readonly<WorkdirSettings> = Object.freeze({
  cloneTimeoutMs: 600_000,
  gitCommandTimeoutMs: 10_000,
  maxEntries: 500,
  maxDepth: 5,
});

/**
 * How the worker program keeps its channel to the router and reports its runs. The settings it shares with the
 * router (heartbeat, event batches, runs at once) are `WORKER_DEFAULTS` in the router's defaults.
 */
export interface WorkerProgramSettings {
  /** The first wait before dialling the router again after the channel dropped. */
  reconnectMinMs: number;
  /** The longest wait between two dials: each failed dial doubles the wait, up to it. */
  reconnectMaxMs: number;
  /** How many heartbeats may pass with nothing on the channel, a ping included, before it counts as dead. */
  silentHeartbeats: number;
  /** How many times a run's events or its finish are sent before the worker gives up on network errors. */
  sendAttempts: number;
  /** The wait between two of those attempts. */
  sendRetryMs: number;
  /** How long a stopping worker waits for its runs to report their end before it closes anyway. */
  stopDeadlineMs: number;
  /** How long one call to a local server's tool may take. Longer than a clone, which `open_repo` may make. */
  localToolTimeoutMs: number;
  /** How long a local server has to start and answer its first listing before it is left out. */
  localStartTimeoutMs: number;
  /** How long a stopping local program gets after each step (its stdin closed, SIGTERM) before the next. */
  localCloseGraceMs: number;
}

export const WORKER_PROGRAM_DEFAULTS: Readonly<WorkerProgramSettings> = Object.freeze({
  reconnectMinMs: 1_000,
  reconnectMaxMs: 30_000,
  silentHeartbeats: 3,
  sendAttempts: 5,
  sendRetryMs: 1_000,
  stopDeadlineMs: 8_000,
  localToolTimeoutMs: 900_000,
  localStartTimeoutMs: 30_000,
  localCloseGraceMs: 2_000,
});
