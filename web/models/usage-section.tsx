import { useQuery } from '@tanstack/react-query';
import { PriceBookDocument, type UsageFieldsFragment } from '@/__generated__/graphql';
import { CardLayout } from '@/components/card-layout';
import { EmptyState } from '@/components/empty-state';
import { LoadState } from '@/components/load-state';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCount } from '@/lib/format';
import { request } from '@/lib/gql';
import { costOf, formatCost, type PriceBook, priceBookFrom } from './cost';

/** How many of the latest days the table shows. */
const RECENT_DAYS = 14;

/** Counts added up for one group of rows. */
interface Totals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** What the priced rows cost; null while none is priced. */
  cost: number | null;
  /** Whether some rows have no price, so the cost is a floor. */
  hasUnpriced: boolean;
}

/** A usage query, as the section reads it: its state, and its rows once they land. */
export interface UsageQuery {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
  /** Usage rows, newest day first. */
  data?: { usageCounts: readonly UsageFieldsFragment[] } | undefined;
}

/** What the usage section is given. */
export interface UsageSectionProps {
  /** The usage query: the section draws its loading and failed states, then its rows. */
  query: UsageQuery;
  /** What each row is grouped by in the totals: the model, or the provider and model. */
  groupBy: (row: UsageFieldsFragment) => string;
  /** What the first column is called. */
  groupLabel: string;
}

/**
 * Adds up rows by a key, keeping the order keys were first seen.
 *
 * @param rows - The rows.
 * @param keyOf - Each row's group.
 * @param book - The prices each row's cost is worked out at.
 * @returns The totals per group.
 */
function totalsBy(
  rows: readonly UsageFieldsFragment[],
  keyOf: (row: UsageFieldsFragment) => string,
  book: PriceBook,
): [string, Totals][] {
  const totals = new Map<string, Totals>();
  for (const row of rows) {
    const key = keyOf(row);
    const sum = totals.get(key) ?? { requests: 0, inputTokens: 0, outputTokens: 0, cost: null, hasUnpriced: false };
    const cost = costOf(row, book);
    totals.set(key, {
      requests: sum.requests + row.requests,
      inputTokens: sum.inputTokens + row.inputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
      cost: cost === null ? sum.cost : (sum.cost ?? 0) + cost,
      hasUnpriced: sum.hasUnpriced || cost === null,
    });
  }
  return [...totals.entries()];
}

/**
 * One table of totals: a label column, then calls, tokens and cost.
 *
 * @param props - The label column's name, and the totals by group.
 * @returns The table.
 */
function TotalsTable({ label, entries }: { label: string; entries: [string, Totals][] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{label}</TableHead>
          <TableHead className="text-right">Calls</TableHead>
          <TableHead className="text-right">Tokens in</TableHead>
          <TableHead className="text-right">Tokens out</TableHead>
          <TableHead className="text-right">Cost</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map(([key, totals]) => (
          <TableRow key={key}>
            <TableCell className="font-mono text-xs">{key}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCount(totals.requests)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCount(totals.inputTokens)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCount(totals.outputTokens)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCost(totals.cost, totals.hasUnpriced)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Calls, tokens and cost, in total by a group and by day for the last two weeks. Untitled: its Usage tab names it.
 *
 * @param props - The usage query, and what its rows are grouped by.
 * @returns The section.
 */
export function UsageSection({ query, groupBy, groupLabel }: UsageSectionProps) {
  const rows = query.data?.usageCounts ?? [];
  const prices = useQuery({ queryKey: ['prices'], queryFn: () => request(PriceBookDocument), meta: { quiet: true } });
  const book = priceBookFrom(prices.data ?? { modelPrices: [], pools: [] });
  const byDay = totalsBy(rows, (row) => row.day ?? 'Earlier', book).slice(0, RECENT_DAYS);
  return (
    <CardLayout
      level={2}
      description="Calls and tokens counted from each provider's own numbers. Days past 90 add up into Earlier. Cost is at the prices entered now, on the provider's Models tab or the pool; ≥ means some calls have no price."
      contentSlot={
        <>
          <LoadState
            compact
            query={query}
            what="its usage"
            count={rows.length}
            emptySlot={<EmptyState compact title="Nothing used yet." />}
          />
          {rows.length > 0 ? (
            <div className="grid gap-4">
              <TotalsTable label={groupLabel} entries={totalsBy(rows, groupBy, book)} />
              <TotalsTable label="Day (UTC)" entries={byDay} />
            </div>
          ) : null}
        </>
      }
    />
  );
}
