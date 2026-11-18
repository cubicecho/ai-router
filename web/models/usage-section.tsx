import type { UsageFieldsFragment } from '@/__generated__/graphql';
import { EmptyState } from '@/components/empty-state';
import { Section } from '@/components/section';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

/** How many of the latest days the table shows. */
const RECENT_DAYS = 14;

/** Counts added up for one group of rows. */
interface Totals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/** What the usage section is given. */
export interface UsageSectionProps {
  /** Usage rows, newest day first. */
  rows: readonly UsageFieldsFragment[];
  /** What each row is grouped by in the totals: the model, or the provider and model. */
  groupBy: (row: UsageFieldsFragment) => string;
  /** What the first column is called. */
  groupLabel: string;
}

const NUMBER = new Intl.NumberFormat();

/**
 * Adds up rows by a key, keeping the order keys were first seen.
 *
 * @param rows - The rows.
 * @param keyOf - Each row's group.
 * @returns The totals per group.
 */
function totalsBy(
  rows: readonly UsageFieldsFragment[],
  keyOf: (row: UsageFieldsFragment) => string,
): [string, Totals][] {
  const totals = new Map<string, Totals>();
  for (const row of rows) {
    const key = keyOf(row);
    const sum = totals.get(key) ?? { requests: 0, inputTokens: 0, outputTokens: 0 };
    totals.set(key, {
      requests: sum.requests + row.requests,
      inputTokens: sum.inputTokens + row.inputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
    });
  }
  return [...totals.entries()];
}

/** One table of totals: a label column, then calls and tokens. */
function TotalsTable({ label, entries }: { label: string; entries: [string, Totals][] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{label}</TableHead>
          <TableHead className="text-right">Calls</TableHead>
          <TableHead className="text-right">Tokens in</TableHead>
          <TableHead className="text-right">Tokens out</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map(([key, totals]) => (
          <TableRow key={key}>
            <TableCell className="font-mono text-xs">{key}</TableCell>
            <TableCell className="text-right tabular-nums">{NUMBER.format(totals.requests)}</TableCell>
            <TableCell className="text-right tabular-nums">{NUMBER.format(totals.inputTokens)}</TableCell>
            <TableCell className="text-right tabular-nums">{NUMBER.format(totals.outputTokens)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Calls and tokens, in total by a group and by day for the last two weeks. */
export function UsageSection({ rows, groupBy, groupLabel }: UsageSectionProps) {
  const byDay = totalsBy(rows, (row) => row.day ?? 'Earlier').slice(0, RECENT_DAYS);
  return (
    <Section
      title="Usage"
      description="Calls and tokens counted from each provider's own numbers. Days past 90 add up into Earlier."
      contentSlot={
        rows.length === 0 ? (
          <EmptyState compact title="Nothing used yet." />
        ) : (
          <div className="grid gap-4">
            <TotalsTable label={groupLabel} entries={totalsBy(rows, groupBy)} />
            <TotalsTable label="Day (UTC)" entries={byDay} />
          </div>
        )
      }
    />
  );
}
