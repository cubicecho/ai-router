import { Link } from '@tanstack/react-router';
import type { RunFilters } from '@/__generated__/graphql';
import { EmptyState } from '@/components/empty-state';
import { LoadError, RowSkeleton } from '@/components/load-state';
import { Section } from '@/components/section';
import { Button } from '@/components/ui/button';
import { ArrowRight } from '@/components/ui/icons';
import { RunsList } from './runs-list';
import type { RunsSearch } from './search';
import { isOpen } from './shapes';
import { useNow, useRuns } from './use-runs';

/** How many runs the section shows, unless told otherwise. */
const RECENT_RUNS = 5;

/** What the section is given. */
export interface RecentRunsSectionProps {
  /** Which runs: one agent's, or one workspace's. */
  where: RunFilters;
  /** The same filter on the Runs page, which "All runs" opens. */
  search: RunsSearch;
  /** What the page is already about, left out of each row. */
  hide: 'agent' | 'workspace';
  /** How many to show. */
  limit?: number | undefined;
}

/** The latest few runs of one agent or one workspace, with the way to all of them. */
export function RecentRunsSection({ where, search, hide, limit = RECENT_RUNS }: RecentRunsSectionProps) {
  const runs = useRuns({ where, limit, offset: 0 });
  const rows = runs.data?.runs ?? [];
  const now = useNow(rows.some((run) => isOpen(run.status)));

  const body = () => {
    if (runs.isError) {
      return <LoadError error={runs.error} onRetry={runs.refetch} what="its runs" compact />;
    }
    if (runs.isPending) {
      return <RowSkeleton rows={2} />;
    }
    if (rows.length === 0) {
      return <EmptyState compact title="No runs yet." />;
    }
    return (
      <RunsList
        rows={rows}
        now={now}
        label="Recent runs"
        hideAgent={hide === 'agent'}
        hideWorkspace={hide === 'workspace'}
      />
    );
  };

  return (
    <Section
      title="Recent runs"
      description={`The latest ${limit}, newest first.`}
      actionSlot={
        rows.length === 0 ? undefined : (
          <Button
            variant="outline"
            size="sm"
            iconSlot={<ArrowRight />}
            linkSlot={<Link to="/agent-runs" search={search} />}
            content="All runs"
          />
        )
      }
      contentSlot={body()}
    />
  );
}
