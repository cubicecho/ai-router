import { Code, CodeBlock } from '@/components/ui/code';
import { CopyButton } from '@/components/ui/copy-button';
import { WORKER_KEY_PLACEHOLDER, workerCommandOf } from './shapes';

/** What the how-to is given. */
export interface WorkerCommandProps {
  /** The worker's key, when it is being shown; the placeholder otherwise. */
  workerKey?: string | undefined;
}

/** How to start a worker on another machine: the one command, from a checkout of ai-router. */
export function WorkerCommand({ workerKey }: WorkerCommandProps) {
  const command = workerCommandOf(window.location.origin, workerKey ?? WORKER_KEY_PLACEHOLDER);
  return (
    <div className="grid gap-2">
      <p className="text-foreground/60 text-sm">
        On the other machine, from a checkout of ai-router, start it with its key. Its work dirs go under{' '}
        <Code>WORKER_ROOT</Code>.
      </p>
      <CodeBlock
        language="sh"
        content={command}
        wrap
        actionSlot={<CopyButton value={command} label="Copy the command" />}
      />
    </div>
  );
}
