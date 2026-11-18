import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { type RunFilters, RunsDocument } from '@/__generated__/graphql';
import { request } from '@/lib/gql';
import { RunStatus } from './shapes';

/** How often a list with a running run in it is read again, so its row ends without a reload. */
const LIVE_REFETCH_MS = 2000;
/** How often a running run's duration ticks. */
const TICK_MS = 1000;

/** Which runs to read, and which page of them. */
export interface RunsPage {
  where: RunFilters;
  limit: number;
  offset: number;
}

/**
 * Reads a page of runs, newest first, and reads it again every couple of seconds while any run on it is running.
 *
 * @param page - The filters and the page.
 * @returns The query.
 */
export function useRuns({ where, limit, offset }: RunsPage) {
  return useQuery({
    queryKey: ['runs', where, limit, offset],
    queryFn: () => request(RunsDocument, { where, limit, offset }),
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => run.status === RunStatus.Running) ? LIVE_REFETCH_MS : false,
    placeholderData: (previous) => previous,
  });
}

/**
 * The time, ticking every second while something on the page is running.
 *
 * @param isTicking - Whether anything shown is running.
 * @returns Epoch milliseconds.
 */
export function useNow(isTicking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (isTicking === false) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [isTicking]);
  return now;
}
