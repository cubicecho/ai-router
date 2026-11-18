import type { ReactElement } from 'react';
import { List, ListRow } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { Badge } from '@/components/ui/badge';
import { CodeBlock } from '@/components/ui/code';
import {
  Bot,
  CircleAlert,
  CircleCheck,
  File,
  FileText,
  GitBranch,
  Info,
  Layers,
  ListChecks,
  RefreshCw,
  Sparkles,
  UserRound,
  Zap,
} from '@/components/ui/icons';
import { formatCount, formatDuration } from './shapes';
import { type TimelineEntry, type TimelineEvent, timelineOf } from './timeline';

/** What the timeline is given. */
export interface RunTimelineProps {
  /** The run's events: live from the subscription, or stored ones read back. In any order; repeats are dropped. */
  events: readonly TimelineEvent[];
  /** When the run started, in epoch milliseconds, which each entry's time is counted from. */
  startedAt: number;
  /** Whether more may come, so a call with no result yet reads as still running rather than unanswered. */
  isLive: boolean;
}

/** How many spaces a call's arguments are indented by. */
const JSON_INDENT = 2;

/** The classes of a block of streamed prose: the model's own words, kept as it wrote them. */
const PROSE_CLASS = 'max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-foreground/5 p-2 text-sm';

/**
 * Shows JSON indented, and anything else as it is.
 *
 * @param text - A call's arguments or a tool's answer.
 * @returns The text to show.
 */
function prettyOf(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, JSON_INDENT);
  } catch {
    return text;
  }
}

/**
 * Capitalises the first letter, for a word the run wrote in lower case.
 *
 * @param text - Such as "turn 2".
 * @returns Such as "Turn 2".
 */
function sentenceOf(text: string): string {
  return `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;
}

/**
 * Says how a call stands.
 *
 * @param entry - The call.
 * @param isLive - Whether the run may still answer it.
 * @returns Its badge.
 */
function callBadge(entry: Extract<TimelineEntry, { type: 'tool' }>, isLive: boolean): ReactElement {
  if (entry.result === null) {
    return isLive ? <Badge variant="info-soft">Running</Badge> : <Badge variant="outline">No result</Badge>;
  }
  return entry.ok === false ? (
    <Badge variant="destructive-soft">Failed</Badge>
  ) : (
    <Badge variant="positive-soft">OK</Badge>
  );
}

/** One call: its arguments, its server's log lines and what it answered. */
function ToolBody({ entry }: { entry: Extract<TimelineEntry, { type: 'tool' }> }) {
  return (
    <div className="grid gap-2 pt-1">
      {entry.args === '' ? null : <CodeBlock title="Arguments" content={prettyOf(entry.args)} wrap maxHeight="sm" />}
      {entry.logs.length === 0 ? null : (
        <CodeBlock
          title="Server log"
          content={entry.logs.map((line) => `${line.level}: ${line.text}`).join('\n')}
          wrap
          maxHeight="sm"
        />
      )}
      {entry.result === null ? null : (
        <CodeBlock
          title={entry.ok === false ? 'Error' : 'Result'}
          content={prettyOf(entry.result)}
          wrap
          maxHeight="sm"
        />
      )}
    </div>
  );
}

/**
 * Draws one entry as a row.
 *
 * @param entry - The entry.
 * @param isLive - Whether the run may still say more.
 * @returns The row's parts.
 */
function rowOf(
  entry: TimelineEntry,
  isLive: boolean,
): {
  icon: ReactElement;
  title: string;
  titleClassName?: string;
  description?: ReactElement | string;
  badge?: ReactElement;
} {
  switch (entry.type) {
    case 'step':
      return { icon: <ListChecks />, title: `Step ${entry.name}`, description: entry.text };
    case 'decision':
      return { icon: <GitBranch />, title: `Chose ${entry.text}` };
    case 'turn':
      return { icon: <RefreshCw />, title: sentenceOf(entry.text === '' ? 'turn' : entry.text) };
    case 'thinking':
      return {
        icon: <Sparkles />,
        title: 'Thought',
        description: <p className={`${PROSE_CLASS} text-foreground/70`}>{entry.text}</p>,
      };
    case 'output':
      return { icon: <Bot />, title: 'Wrote', description: <p className={PROSE_CLASS}>{entry.text}</p> };
    case 'tool':
      return {
        icon: <Zap />,
        title: entry.name,
        titleClassName: 'font-mono',
        description: <ToolBody entry={entry} />,
        badge: callBadge(entry, isLive),
      };
    case 'input':
      return { icon: <UserRound />, title: 'Input handed in', description: entry.text };
    case 'artifact':
      return { icon: <File />, title: entry.text, description: entry.uri ?? undefined };
    case 'log':
      return { icon: <FileText />, title: `${entry.name} logged`, description: `${entry.level}: ${entry.text}` };
    case 'usage': {
      const { usage } = entry;
      const total = `${formatCount(usage.promptTokens)} in · ${formatCount(usage.completionTokens)} out so far`;
      return usage.turn === null
        ? { icon: <Layers />, title: total }
        : {
            icon: <Layers />,
            title: `Used ${formatCount(usage.turn.prompt)} in · ${formatCount(usage.turn.completion)} out`,
            description: total,
          };
    }
    case 'done':
      return {
        icon: entry.ok ? <CircleCheck /> : <CircleAlert />,
        title: entry.ok ? 'Done' : 'Ended without an answer',
        description: entry.text === '' ? undefined : entry.text,
      };
    case 'note':
      return {
        icon: <Info />,
        title: entry.kind === 'notice' ? sentenceOf(entry.text) : `${sentenceOf(entry.kind)}: ${entry.text}`,
      };
  }
}

/**
 * A run's events as a readable timeline: its steps, each turn, what it thought and wrote, every tool call with its
 * result, the notes of its side tasks, and its usage after each turn.
 */
export function RunTimeline({ events, startedAt, isLive }: RunTimelineProps) {
  const entries = timelineOf(events);
  return (
    <List
      label="Events"
      contentSlot={entries.map((entry) => {
        const row = rowOf(entry, isLive);
        const since = formatDuration(Math.max(0, entry.at - startedAt));
        return (
          <ListRow key={entry.key} depth={entry.step === '' || entry.type === 'step' ? 0 : 1}>
            <ListItem
              leadingSlot={<span className="flex size-4 text-foreground/60 [&>svg]:size-4">{row.icon}</span>}
              title={row.title}
              titleClassName={row.titleClassName}
              description={row.description}
              meta={
                <span className="flex items-center gap-2">
                  {row.badge}
                  <span className="text-foreground/60 text-xs tabular-nums">+{since}</span>
                </span>
              }
            />
          </ListRow>
        );
      })}
    />
  );
}
