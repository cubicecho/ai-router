import type { AgentRevisionFieldsFragment } from '@/__generated__/graphql';
import { DialogLayout } from '@/components/dialog-layout';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { CopyButton } from '@/components/ui/copy-button';
import { Findings } from './findings';
import { documentText, stringsOf, whenOf, whoOf } from './shapes';

/** What the revision dialog is given. */
export interface RevisionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  revision: AgentRevisionFieldsFragment;
}

/** One saved revision, read only: its document and the warnings it was saved with. */
export function RevisionDialog({ open, onOpenChange, revision }: RevisionDialogProps) {
  const text = documentText(revision.document);
  const saved = `Saved by ${whoOf(revision.creator)}, ${whenOf(revision.createdAt)}.`;

  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      title={`Revision ${revision.number}`}
      description={revision.message === '' ? saved : `“${revision.message}” ${saved}`}
      size="lg"
      contentSlot={
        <div className="grid gap-4">
          <Findings findings={{ errors: [], warnings: stringsOf(revision.warnings) }} />
          <CodeBlock
            title="Document"
            language="json"
            content={text}
            maxHeight="lg"
            actionSlot={<CopyButton value={text} label={`Copy revision ${revision.number}`} />}
          />
        </div>
      }
      footerActionsSlot={(close) => <Button variant="outline" onClick={close} content="Close" />}
    />
  );
}
