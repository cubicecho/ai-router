/** Where a run is in its life, as the runs table spells it. */
export const RunStatus = {
  Running: 'running',
  Waiting: 'waiting',
  Completed: 'completed',
  Failed: 'failed',
  Cancelled: 'cancelled',
  Expired: 'expired',
} as const;
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

/** The statuses the filter offers, in the order a person thinks of them. */
export const RUN_STATUS_CHOICES: readonly { value: RunStatus; label: string }[] = [
  { value: RunStatus.Running, label: 'Running' },
  { value: RunStatus.Waiting, label: 'Waiting for the app' },
  { value: RunStatus.Completed, label: 'Completed' },
  { value: RunStatus.Failed, label: 'Failed' },
  { value: RunStatus.Cancelled, label: 'Cancelled' },
  { value: RunStatus.Expired, label: 'Expired' },
];

/**
 * Whether a run has yet to end: running, or waiting for the app to answer its tool calls.
 *
 * @param status - The run's status.
 * @returns true until it completes, fails, is cancelled or expires.
 */
export function isOpen(status: string): boolean {
  return status === RunStatus.Running || status === RunStatus.Waiting;
}

/**
 * Reads a status from the address bar.
 *
 * @param value - Anything.
 * @returns The status, or undefined for anything the filter doesn't offer.
 */
export function statusOf(value: unknown): RunStatus | undefined {
  return RUN_STATUS_CHOICES.find((choice) => choice.value === value)?.value;
}

/** The units a duration is written in. */
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/** The longest a run is said in milliseconds before it is said in seconds. */
const MAX_MS_SHOWN = 1000;
/** The longest a run is said in seconds alone. */
const MAX_SECONDS_SHOWN = 90;

/** How many characters of an error a row shows. */
export const SHORT_ERROR_LENGTH = 90;

const NUMBER = new Intl.NumberFormat();

/**
 * How long a run took, or has taken so far.
 *
 * @param run - Its start and its end, as ISO timestamps; `finishedAt` is null while it runs.
 * @param now - The time a running run is measured to.
 * @returns The milliseconds.
 */
export function durationOf(run: { startedAt: string; finishedAt: string | null }, now: number): number {
  const end = run.finishedAt === null ? now : Date.parse(run.finishedAt);
  return Math.max(0, end - Date.parse(run.startedAt));
}

/**
 * Writes a duration the way a person reads it.
 *
 * @param ms - The milliseconds.
 * @returns Such as "850 ms", "12 s", "3 min 4 s" or "1 h 2 min".
 */
export function formatDuration(ms: number): string {
  if (ms < MAX_MS_SHOWN) {
    return `${Math.round(ms)} ms`;
  }
  const seconds = Math.round(ms / MS_PER_SECOND);
  if (seconds < MAX_SECONDS_SHOWN) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    const rest = seconds % SECONDS_PER_MINUTE;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const rest = minutes % MINUTES_PER_HOUR;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * Formats a count.
 *
 * @param count - The number.
 * @returns It with the reader's digit grouping.
 */
export function formatCount(count: number): string {
  return NUMBER.format(count);
}

/**
 * Writes a run's tokens.
 *
 * @param run - Its counts.
 * @returns Such as "1,200 in · 340 out".
 */
export function formatTokens(run: { inputTokens: number; outputTokens: number }): string {
  return `${formatCount(run.inputTokens)} in · ${formatCount(run.outputTokens)} out`;
}

/**
 * Shortens an error to one line for a row.
 *
 * @param error - The whole error.
 * @param [length] - How many characters to keep.
 * @returns Its first line, cut with an ellipsis when it runs long.
 */
export function shortError(error: string, length: number = SHORT_ERROR_LENGTH): string {
  const [line = ''] = error.trim().split('\n');
  return line.length > length ? `${line.slice(0, length - 1).trimEnd()}…` : line;
}

/**
 * Formats a timestamp as a date and a time.
 *
 * @param iso - An ISO timestamp.
 * @returns Such as "18 Nov 2026, 09:14:05", in the reader's locale.
 */
export function startedOf(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}
