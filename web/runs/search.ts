import { tabSearch } from '@/lib/tab-search';
import { type RunStatus, statusOf } from './shapes';

/** How many runs a page shows. */
export const RUNS_PER_PAGE = 25;

/** The runs screen's tabs, the default first: each run, or the runs grouped by the session the app sent them under. */
export const RUNS_TABS = ['runs', 'sessions'] as const;
export type RunsTab = (typeof RUNS_TABS)[number];

/** What each of the runs screen's tabs is called. */
export const RUNS_TAB_LABELS: Readonly<Record<RunsTab, string>> = {
  runs: 'Runs',
  sessions: 'Sessions',
};

/** The run page's tabs, the default first, as the address bar names them: `?tab=details`. */
export const RUN_TABS = ['timeline', 'details', 'events'] as const;
export type RunTab = (typeof RUN_TABS)[number];

/** What each of the run page's tabs is called. */
export const RUN_TAB_LABELS: Readonly<Record<RunTab, string>> = {
  timeline: 'Timeline',
  details: 'Details',
  events: 'Raw events',
};

/** The tab, the filters and the page, as the address bar holds them. */
export interface RunsSearch {
  tab?: RunsTab | undefined;
  /** The agent's name, which never changes and outlives the agent. */
  agent?: string | undefined;
  /** The workspace's id, since its slug can change. */
  workspace?: string | undefined;
  status?: RunStatus | undefined;
  /** One session's key, which the Runs tab shows only the runs of. */
  session?: string | undefined;
  /** From 1. */
  page?: number | undefined;
}

/**
 * Reads the tab and filters from the address bar, keeping only what the page can use.
 *
 * @param search - The parsed query string.
 * @returns The filters.
 */
export function validateRunsSearch(search: Record<string, unknown>): RunsSearch {
  const page = typeof search.page === 'number' ? search.page : Number(search.page);
  // The router reads a value that looks like JSON as JSON, so an agent named `42` arrives as a number.
  const agent = typeof search.agent === 'number' ? String(search.agent) : search.agent;
  const session = typeof search.session === 'number' ? String(search.session) : search.session;
  return {
    ...tabSearch(RUNS_TABS)(search),
    agent: typeof agent === 'string' && agent !== '' ? agent : undefined,
    workspace: typeof search.workspace === 'string' && search.workspace !== '' ? search.workspace : undefined,
    status: statusOf(search.status),
    session: typeof session === 'string' && session !== '' ? session : undefined,
    page: Number.isInteger(page) && page > 1 ? page : undefined,
  };
}
