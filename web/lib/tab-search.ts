/** A detail page's open tab, as the address bar holds it: `?tab=keys`. The first tab is the default, and leaves it out. */
export interface TabSearch<TTab extends string> {
  tab?: TTab | undefined;
}

/**
 * Builds a route's `validateSearch` for a page with tabs, so a tab can be linked to and survives a reload.
 *
 * @typeParam TTab - The page's tabs.
 * @param tabs - Every tab the page has, the default first.
 * @returns A validator that keeps `tab` when it names one of them, and drops it otherwise.
 */
export function tabSearch<TTab extends string>(
  tabs: readonly TTab[],
): (search: Record<string, unknown>) => TabSearch<TTab> {
  const [first] = tabs;
  return (search) => {
    const tab = tabs.find((candidate) => candidate === search.tab);
    return { tab: tab === undefined || tab === first ? undefined : tab };
  };
}

/**
 * Reads the open tab.
 *
 * @typeParam TTab - The page's tabs.
 * @param tabs - Every tab the page can have, the default first.
 * @param shown - The tabs this record's page has.
 * @param named - The address's `tab`.
 * @returns The tab it names, or the first when it names none, or one this page lacks.
 */
export function openTab<TTab extends string>(
  tabs: readonly [TTab, ...TTab[]],
  shown: readonly TTab[],
  named: unknown,
): TTab {
  const [first] = tabs;
  const tab = tabs.find((candidate) => candidate === named);
  return tab !== undefined && shown.includes(tab) ? tab : first;
}
