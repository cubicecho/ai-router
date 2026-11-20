import type { ReactElement } from 'react';
import { CardLayout } from '@/components/card-layout';
import { CollapsibleRow } from '@/components/collapsible-row';
import { EmptyState } from '@/components/empty-state';
import { List } from '@/components/list';
import { Markdown } from '@/components/markdown';
import { Settings, UserRound, Zap } from '@/components/ui/icons';
import { useOpenRows } from '@/lib/use-open-rows';
import { INPUT_ROLE_LABELS, type InputMessage, InputRole } from './input';

/** What the input card is given. */
export interface RunInputProps {
  /** The run's input, read with `inputMessagesOf`. */
  messages: readonly InputMessage[];
}

/** The glyph each role is drawn with, so the instructions and what a person asked read apart at a glance. */
const ROLE_ICONS: Readonly<Record<InputRole, ReactElement>> = {
  [InputRole.System]: <Settings />,
  [InputRole.Developer]: <Settings />,
  [InputRole.User]: <UserRound />,
  [InputRole.Tool]: <Zap />,
};

/** The roles whose messages are instructions rather than a turn, drawn quieter. */
const INSTRUCTION_ROLES: ReadonlySet<InputRole> = new Set([InputRole.System, InputRole.Developer]);

/**
 * Says what a message carried beside its text.
 *
 * @param message - The message.
 * @returns The call it answers, or how many images it had; null when neither.
 */
function factsOf(message: InputMessage): string | null {
  if (message.toolCallId !== null) {
    return `Answers ${message.toolCallId}`;
  }
  if (message.images > 0) {
    return message.images === 1 ? '1 image, not kept' : `${message.images} images, not kept`;
  }
  return null;
}

/**
 * What the app gave a run: the messages of the request that started it, then the answers of each request that
 * resumed it. A closed row shows the start of its text, and opens onto all of it.
 */
export function RunInput({ messages }: RunInputProps) {
  const rows = useOpenRows<number>();
  return (
    <CardLayout
      level={2}
      title="Input"
      description="What the app sent: its system and user messages, then its answers to the calls handed back."
      contentSlot={
        <List
          label="Input messages"
          contentSlot={messages.map((message, index) => {
            const isOpen = rows.isOpen(index);
            const facts = factsOf(message);
            const isInstruction = INSTRUCTION_ROLES.has(message.role);
            return (
              <CollapsibleRow
                // biome-ignore lint/suspicious/noArrayIndexKey: messages have no id, and the input only grows at its end
                key={index}
                open={isOpen}
                onOpenChange={(next) => rows.setOpen(index, next)}
                badgesSlot={
                  <span className="flex size-4 shrink-0 text-foreground/60 [&>svg]:size-4">
                    {ROLE_ICONS[message.role]}
                  </span>
                }
                title={INPUT_ROLE_LABELS[message.role]}
                meta={facts === null ? undefined : <span className="text-foreground/60 text-xs">{facts}</span>}
                description={isOpen ? undefined : message.content}
                contentSlot={
                  <Markdown content={message.content} className={isInstruction ? 'text-foreground/70' : undefined} />
                }
              />
            );
          })}
        />
      }
      emptySlot={<EmptyState compact title="No input was kept for this run." />}
    />
  );
}
