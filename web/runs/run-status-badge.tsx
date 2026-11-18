import { Badge } from '@/components/ui/badge';
import { RUN_STATUS_CHOICES, RunStatus } from './shapes';

/** The badge each status wears. A status this list doesn't know yet is drawn plain. */
const VARIANTS: Readonly<
  Record<string, 'info-soft' | 'warning-soft' | 'positive-soft' | 'destructive-soft' | 'secondary'>
> = {
  [RunStatus.Running]: 'info-soft',
  [RunStatus.Waiting]: 'warning-soft',
  [RunStatus.Completed]: 'positive-soft',
  [RunStatus.Failed]: 'destructive-soft',
  [RunStatus.Cancelled]: 'secondary',
  [RunStatus.Expired]: 'secondary',
};

/**
 * Names a status.
 *
 * @param status - The run's status.
 * @returns Its label, or the status itself with a capital for one the UI doesn't know yet.
 */
export function statusLabel(status: string): string {
  const known = RUN_STATUS_CHOICES.find((choice) => choice.value === status);
  return known?.label ?? `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

/** A run's status, as a badge whose word says it and whose colour repeats it. */
export function RunStatusBadge({ status }: { status: string }) {
  return <Badge variant={VARIANTS[status] ?? 'outline'}>{statusLabel(status)}</Badge>;
}
