import { Alert } from '@/components/ui/alert';
import { CircleCheck } from '@/components/ui/icons';
import type { DocumentFindings } from './shapes';

/**
 * Lists lines as a bulleted list, for an alert's description.
 *
 * @param lines - The lines.
 * @returns The list.
 */
function lineList(lines: readonly string[]) {
  return (
    <ul className="list-disc space-y-1 pl-5">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/** What the findings are given. */
export interface FindingsProps {
  findings: DocumentFindings;
  /** Whether to say so when there is nothing to report: after a check, but not over a saved revision. */
  showClean?: boolean | undefined;
}

/** A document's errors and warnings, every one of them, each kind in an alert of its own. */
export function Findings({ findings, showClean = false }: FindingsProps) {
  const { errors, warnings } = findings;
  if (errors.length === 0 && warnings.length === 0) {
    return showClean ? (
      <Alert variant="info" iconSlot={<CircleCheck />} title="No problems found" description="It can be saved." />
    ) : null;
  }
  return (
    <>
      {errors.length === 0 ? null : (
        <Alert
          variant="destructive"
          title={
            errors.length === 1
              ? "It can't be saved, for one reason"
              : `It can't be saved, for ${errors.length} reasons`
          }
          description={lineList(errors)}
        />
      )}
      {warnings.length === 0 ? null : (
        <Alert
          variant="warning"
          title={warnings.length === 1 ? 'One thing worth a look' : `${warnings.length} things worth a look`}
          description={lineList(warnings)}
        />
      )}
    </>
  );
}
