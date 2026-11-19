import { useNavigate, useSearch } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { titleColumn } from '@/components/page-layout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { openTab } from '@/lib/tab-search';
import { cn, type SlotNode } from '@/lib/utils';

// A detail page in tabs: the open tab is in the address (`?tab=keys`, see `lib/tab-search`), the tab bar sits in the
// page header's bar, and each tab's panel lays out like the page body. One `DetailTabs` root goes round the whole
// `PageLayout`, so the triggers in its header name the panels in its body.

/** How each panel lays out what it holds: the page body's own gap, and none of the pane's top margin. */
const PANEL_CLASS = 'mt-0 flex flex-col gap-4';

/**
 * Reads the address's search as any route holds it.
 *
 * @returns Every route's search params, each optional.
 */
function useAnySearch() {
  return useSearch({ strict: false });
}

/** Every tab any detail page's route takes in `?tab=`. */
type RouteTab = NonNullable<ReturnType<typeof useAnySearch>['tab']>;

/** The open tab, and the way to open another. */
export interface DetailTab<TTab extends RouteTab> {
  tab: TTab;
  /**
   * Opens a tab, replacing the address rather than adding to the history.
   *
   * @param value - The tab, as the tab bar names it. Anything else is ignored.
   */
  showTab: (value: string) => void;
}

/**
 * Reads a detail page's open tab from the address, and opens others there.
 *
 * @typeParam TTab - The page's tabs.
 * @param tabs - Every tab the page can have, the default first, as its route's `tabSearch` was given them.
 * @param [shown] - The tabs this record's page has, when some are left out. A link to one it lacks opens the first.
 * @returns The open tab, and `showTab`.
 */
export function useDetailTab<TTab extends RouteTab>(
  tabs: readonly [TTab, ...TTab[]],
  shown: readonly TTab[] = tabs,
): DetailTab<TTab> {
  const search = useAnySearch();
  const navigate = useNavigate();
  const [first] = tabs;
  const tab = openTab(tabs, shown, search.tab);
  const showTab = (value: string) => {
    const next = tabs.find((candidate) => candidate === value);
    if (next === undefined) {
      return;
    }
    // The default tab leaves `tab` out, as `tabSearch` would.
    void navigate({ to: '.', search: (prev) => ({ ...prev, tab: next === first ? undefined : next }), replace: true });
  };
  return { tab, showTab };
}

/** What a tabbed detail page is given. */
interface DetailTabsProps {
  /** The open tab, from {@link useDetailTab}. */
  value: string;
  /** Opens a tab: `showTab` from {@link useDetailTab}. */
  onValueChange: (value: string) => void;
  /** The page, a `PageLayout` with a {@link DetailTabBar} in its `headerBarSlot` and panels in its body. */
  children: ReactNode;
}

/**
 * The root of a tabbed detail page, round the whole page.
 *
 * @param props - The open tab, and the page.
 * @returns The page, in tabs.
 */
export function DetailTabs({ value, onValueChange, children }: DetailTabsProps) {
  return (
    <Tabs value={value} onValueChange={onValueChange} className="h-full">
      {children}
    </Tabs>
  );
}

/** What the tab bar is given. */
interface DetailTabBarProps<TTab extends string> {
  /** The tabs to draw, in order. */
  tabs: readonly TTab[];
  /** What each tab is called. */
  labels: Readonly<Record<TTab, string>>;
  /** What the bar is called, for a screen reader. */
  label: string;
  /** What follows a tab's name, such as a count. */
  trailing?: Partial<Record<TTab, SlotNode>>;
  /** What sits above the tabs in the header's bar, such as a few facts about the record. */
  leadSlot?: ReactNode;
}

/**
 * The tabs of a detail page, for its `headerBarSlot`, lined up under the title.
 *
 * @typeParam TTab - The page's tabs.
 * @param props - The tabs, their names and what follows them.
 * @returns The bar.
 */
export function DetailTabBar<TTab extends string>({
  tabs,
  labels,
  label,
  trailing,
  leadSlot,
}: DetailTabBarProps<TTab>) {
  return (
    <div className={cn(titleColumn('page'), 'flex flex-col gap-3 pb-3')}>
      {leadSlot}
      <TabsList aria-label={label}>
        {tabs.map((value) => (
          <TabsTrigger key={value} value={value} trailingSlot={trailing?.[value]}>
            {labels[value]}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  );
}

/** What a tab's panel is given. */
interface DetailTabPanelProps {
  /** The tab it belongs to. */
  value: string;
  children: ReactNode;
  /** Merged after the panel's own layout, to change its gap. */
  className?: string;
  /** Keeps the panel mounted while another tab is open, hidden, for a section that must keep listening. */
  forceMount?: boolean;
}

/**
 * One tab's panel, laid out as the page body is.
 *
 * @param props - Its tab, and what it holds.
 * @returns The panel.
 */
export function DetailTabPanel({ value, children, className, forceMount = false }: DetailTabPanelProps) {
  return (
    <TabsContent
      value={value}
      className={cn(PANEL_CLASS, forceMount && 'data-[state=inactive]:hidden', className)}
      {...(forceMount ? { forceMount: true } : {})}
    >
      {children}
    </TabsContent>
  );
}
