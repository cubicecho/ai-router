import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from '@/components/ui/icons';
import { formatCount } from './shapes';

/** What the pager is given. */
export interface PagerProps {
  /** The page shown, from 1. */
  page: number;
  /** How many rows a page holds. */
  perPage: number;
  /** How many rows this page shows. */
  shown: number;
  /** How many rows match in all. */
  total: number;
  /** What the rows are, plural, for the count when the page is empty: "runs". */
  what: string;
  /** Opens another page. */
  onPage: (page: number) => void;
}

/** Where a page of runs or sessions sits among them all, and the way to the newer and older pages. */
export function Pager({ page, perPage, shown, total, what, onPage }: PagerProps) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const first = (page - 1) * perPage + 1;
  const last = first + shown - 1;
  return (
    <div className="flex items-center justify-between gap-2 text-foreground/70 text-sm">
      <span className="tabular-nums">
        {shown === 0
          ? `${formatCount(total)} ${what}`
          : `${formatCount(first)}–${formatCount(last)} of ${formatCount(total)}`}
      </span>
      <span className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          iconSlot={<ChevronLeft />}
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          content="Newer"
        />
        <Button
          variant="outline"
          size="sm"
          iconSlot={<ChevronRight />}
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          content="Older"
        />
      </span>
    </div>
  );
}
