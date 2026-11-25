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
