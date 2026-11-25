import { DialogLayout } from '@/components/dialog-layout';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code';
import { CopyButton } from '@/components/ui/copy-button';
import { KeyRound } from '@/components/ui/icons';
import { WorkerCommand } from './worker-command';

/** What the dialog is given. */
export interface WorkerKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The worker the key is for, for the title. */
  workerName: string;
  /** The whole key, from the answer that made it. */
  secret: string;
}

/** Shows a worker's new key, once, with the command that starts the worker with it. */
export function WorkerKeyDialog({ open, onOpenChange, workerName, secret }: WorkerKeyDialogProps) {
  return (
    <DialogLayout
      open={open}
      onOpenChange={onOpenChange}
      iconSlot={<KeyRound />}
      title={`${workerName}'s key`}
      contentSlot={
        <>
          <Alert
            variant="warning"
            title="Copy it now"
            description="You won't see this key again. The router keeps only a hash of it."
          />
          <CodeBlock content={secret} wrap actionSlot={<CopyButton value={secret} label="Copy key" />} />
          <WorkerCommand workerKey={secret} />
        </>
      }
      footerActionsSlot={(dismiss) => <Button variant="default" onClick={dismiss} content="Done" />}
    />
  );
}
