import type { ReactNode } from 'react';
import { hasSlot, type SlotNode } from '@/lib/utils';

/** What a detail page's title is given. */
export interface PageTitleProps {
  /** The record's name. */
  title: ReactNode;
  /** Its state, as the badges its row on the list wears: Off, Built in, Can't run, No keys. */
  badgesSlot?: SlotNode | undefined;
}

/**
 * A detail page's title, with the badges that say what state the record is in beside it. Every detail page puts its
 * state there, so a page and its row on the list say the same thing in the same place.
 */
export function PageTitle({ title, badgesSlot }: PageTitleProps) {
  if (hasSlot(badgesSlot) === false) {
    return <>{title}</>;
  }
  return (
    <span className="flex items-center gap-2">
      {title}
      <span className="flex items-center gap-1">{badgesSlot}</span>
    </span>
  );
}
