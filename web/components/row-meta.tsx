import { Children, type ReactNode } from 'react';
import { hasSlot, type SlotNode } from '@/lib/utils';

// Every list row in the router is drawn the same way:
// - the title is the thing's display name, or its name when it has none, in the title's own font even when it is a name;
//   only a list whose every title is code (env var names, `provider/model` ids, a run's agent) sets them in monospace;
// - the description is one plain line, its parts joined by " · " (`joinStats` from `@/lib/format`; `ListItem` draws
//   no line for the empty string it gives when every part is absent);
// - the meta is `RowMeta`: the name first when the title is the display name, then the small facts, then the badges.
// Badges say a state: `outline` for something switched off, `warning-soft` for what stops it being used,
// `info-soft` for what wants a look, `positive-soft` for what is set or worked, `destructive-soft` for what failed or
// ran out, `secondary` for a plain fact.

/** What a row's far end is given. */
export interface RowMetaProps {
  /**
   * The small grey facts, in order: a name, a count, a time. Absent ones (`null`, `undefined`, `false`) are skipped.
   * An element among them carries a `key`, as in any array.
   */
  facts?: readonly ReactNode[] | undefined;
  /** The badges after the facts: what state the thing is in. */
  badgesSlot?: SlotNode | undefined;
}

/** A list row's far end: its facts, muted and spaced alike on every list, then its badges. */
export function RowMeta({ facts = [], badgesSlot }: RowMetaProps) {
  return (
    <span className="flex items-center gap-4 text-foreground/60 text-xs tabular-nums">
      {Children.map(Children.toArray(facts), (fact) => (
        <span>{fact}</span>
      ))}
      {hasSlot(badgesSlot) ? <span className="flex items-center gap-1">{badgesSlot}</span> : null}
    </span>
  );
}

/**
 * The name as a row's first fact, for a row whose title is its display name.
 *
 * @param displayName - What it is called for people, if anything.
 * @param name - The name agents and configs use.
 * @returns The name in monospace, or `null` when the title already is the name.
 */
export function rowNameFact(displayName: string | null | undefined, name: string): ReactNode {
  const isTitleTheName = displayName === null || displayName === undefined || displayName === name;
  return isTitleTheName ? null : (
    <span key="name" className="font-mono">
      {name}
    </span>
  );
}
