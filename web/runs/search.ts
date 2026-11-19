import { type RunStatus, statusOf } from './shapes';

/** How many runs a page shows. */
export const RUNS_PER_PAGE = 25;

/** The run page's tabs, the default first, as the address bar names them: `?tab=details`. */
export const RUN_TABS = ['timeline', 'details', 'events'] as const;
export type RunTab = (typeof RUN_TABS)[number];

/** What each of the run page's tabs is called. */
export const RUN_TAB_LABELS: Readonly<Record<RunTab, string>> = {
  timeline: 'Timeline',
  details: 'Details',
  events: 'Raw events',
};

/** The filters and the page, as the address bar holds them. */
export interface RunsSearch {
  /** The agent's name, which never changes and outlives the agent. */
  agent?: string | undefined;
  /** The workspace's id, since its slug can change. */
  workspace?: string | undefined;
  status?: RunStatus | undefined;
  /** From 1. */
  page?: number | undefined;
}

/**
 * Reads the filters from the address bar, keeping only what the page can use.
 *
 * @param search - The parsed query string.
 * @returns The filters.
 */
export function validateRunsSearch(search: Record<string, unknown>): RunsSearch {
  const page = typeof search.page === 'number' ? search.page : Number(search.page);
  // The router reads a value that looks like JSON as JSON, so an agent named `42` arrives as a number.
  const agent = typeof search.agent === 'number' ? String(search.agent) : search.agent;
  return {
    agent: typeof agent === 'string' && agent !== '' ? agent : undefined,
    workspace: typeof search.workspace === 'string' && search.workspace !== '' ? search.workspace : undefined,
    status: statusOf(search.status),
    page: Number.isInteger(page) && page > 1 ? page : undefined,
  };
}
