import { Link } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { CollapsibleRow } from '@/components/collapsible-row';
import { List, ListRow } from '@/components/list';
import { ListItem } from '@/components/list-item';
import { Markdown } from '@/components/markdown';
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
import { formatCount } from '@/lib/format';
import { useOpenRows } from '@/lib/use-open-rows';
import { formatDuration } from './shapes';
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

/** One entry drawn as a row: what its summary line shows, and what it opens onto. */
interface TimelineRow {
  icon: ReactElement;
  title: ReactNode;
  /** A short fact under the title, shown whether the row is open or not. */
  description?: string | undefined;
  /** The detail the row opens onto: the text, a call's arguments and result, a log line. */
  body?: ReactElement | undefined;
  badge?: ReactElement | undefined;
}

/** How many spaces a call's arguments are indented by. */
const JSON_INDENT = 2;

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

/** One call: its arguments, its server's log lines and progress, the agent run it started, and what it answered. */
function ToolBody({ entry, isLive }: { entry: Extract<TimelineEntry, { type: 'tool' }>; isLive: boolean }) {
  const { calledRunId } = entry;
  return (
    <div className="grid gap-2">
      {calledRunId === null ? null : (
        <span className="text-sm">
          Ran as{' '}
          <Link to="/agent-runs/$runId" params={{ runId: calledRunId }} className="underline underline-offset-2">
            run {calledRunId}
          </Link>
        </span>
      )}
      {entry.args === '' ? null : <CodeBlock title="Arguments" content={prettyOf(entry.args)} wrap maxHeight="sm" />}
      {entry.progress.length === 0 ? null : (
        <CodeBlock title="Progress" content={entry.progress.join('\n')} wrap maxHeight="sm" />
      )}
      {entry.nested.length === 0 ? null : <RunTimeline events={entry.nested} startedAt={entry.at} isLive={isLive} />}
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
function rowOf(entry: TimelineEntry, isLive: boolean): TimelineRow {
  switch (entry.type) {
    case 'exchange':
      return {
        icon: <ListChecks />,
        title: entry.name === '' ? 'Exchange' : `Exchange ${entry.name}`,
        body: entry.text === '' ? undefined : <Markdown content={entry.text} />,
      };
    case 'decision':
      return { icon: <GitBranch />, title: `Chose ${entry.text}` };
    case 'turn':
      return { icon: <RefreshCw />, title: sentenceOf(entry.text === '' ? 'turn' : entry.text) };
    case 'thinking':
      return {
        icon: <Sparkles />,
        title: 'Thought',
        body: <Markdown content={entry.text} className="text-foreground/70" />,
      };
    case 'output':
      return { icon: <Bot />, title: 'Wrote', body: <Markdown content={entry.text} /> };
    case 'tool':
      return {
        icon: <Zap />,
        title: <span className="font-mono">{entry.name}</span>,
        body: <ToolBody entry={entry} isLive={isLive} />,
        badge: callBadge(entry, isLive),
      };
    case 'input':
      return { icon: <UserRound />, title: 'Input handed in', body: <Markdown content={entry.text} /> };
    case 'artifact':
      return { icon: <File />, title: entry.text, description: entry.uri ?? undefined };
    case 'log':
      return {
        icon: <FileText />,
        title: `${entry.name} logged`,
        body: <CodeBlock content={`${entry.level}: ${entry.text}`} wrap maxHeight="md" />,
      };
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
 * A run's events as a readable timeline: its exchanges, each turn, what it thought and wrote, every tool call with its
 * result, the notes of its side tasks, and its usage after each turn. A row with detail opens onto it, and starts
 * closed; a row with none is a plain row.
 */
export function RunTimeline({ events, startedAt, isLive }: RunTimelineProps) {
  const rows = useOpenRows<number>();
  const entries = timelineOf(events);
  return (
    <List
      label="Events"
      contentSlot={entries.map((entry) => {
        const row = rowOf(entry, isLive);
        const since = formatDuration(Math.max(0, entry.at - startedAt));
        const icon = <span className="flex size-4 shrink-0 text-foreground/60 [&>svg]:size-4">{row.icon}</span>;
        const meta = (
          <span className="flex items-center gap-2">
            {row.badge}
            <span className="text-foreground/60 text-xs tabular-nums">+{since}</span>
          </span>
        );
        return (
          <ListRow key={entry.key} depth={entry.exchange === '' || entry.type === 'exchange' ? 0 : 1}>
            {row.body === undefined ? (
              <ListItem
                // Where an opening row has its chevron, so the icons line up down the list.
                leadingSlot={
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="size-4 shrink-0" />
                    {icon}
                  </span>
                }
                title={row.title}
                description={row.description}
                meta={meta}
              />
            ) : (
              <CollapsibleRow
                open={rows.isOpen(entry.key)}
                onOpenChange={(isOpen) => rows.setOpen(entry.key, isOpen)}
                badgesSlot={icon}
                title={row.title}
                description={row.description}
                meta={meta}
                contentSlot={row.body}
              />
            )}
          </ListRow>
        );
      })}
    />
  );
}
