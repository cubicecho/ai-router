import type { WorkerFieldsFragment } from '@/__generated__/graphql';
import { Badge } from '@/components/ui/badge';
import { WorkerStatus, workerStatusOf } from './shapes';

/** The badge each status wears: its words say it, and the colour repeats them. */
const BADGES = {
  [WorkerStatus.BuiltIn]: { variant: 'secondary', label: 'Built in' },
  [WorkerStatus.NeverSeen]: { variant: 'warning-soft', label: 'Never connected' },
  [WorkerStatus.Seen]: null,
} as const satisfies Record<
  WorkerStatus,
  { variant: 'secondary' | 'warning-soft' | 'positive-soft'; label: string } | null
>;

/** What the badge is given. */
export interface WorkerStatusBadgeProps {
  worker: Pick<WorkerFieldsFragment, 'name' | 'lastSeenAt'>;
}

/** Where a worker stands, as a badge, or nothing when its last-seen time already says it. */
export function WorkerStatusBadge({ worker }: WorkerStatusBadgeProps) {
  const badge = BADGES[workerStatusOf(worker)];
  return badge === null ? null : <Badge variant={badge.variant}>{badge.label}</Badge>;
}
