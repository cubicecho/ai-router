/**
 * One thing a run did: agent-core's `RunEvent`, as the `runEvents` subscription sends it live and as phase 7 will read
 * it back from `run_events`. Only the fields the timeline reads.
 */
export interface TimelineEvent {
  seq: number;
  /** Epoch milliseconds. */
  at: number;
  kind: string;
  text: string;
  name: string;
  id?: string | null | undefined;
  step: string;
  ok: boolean | null;
  usage?: unknown;
  level?: string | null | undefined;
  link?: unknown;
}

/** agent-core's `RunEventKind`, the kinds the timeline draws. Any other kind is drawn as a note. */
export const EventKind = {
  Step: 'step',
  Decision: 'decision',
  Turn: 'turn',
  Thinking: 'thinking',
  Output: 'output',
  ToolCall: 'tool-call',
  ToolResult: 'tool-result',
  Notice: 'notice',
  Input: 'input',
  Artifact: 'artifact',
  ServerLog: 'server-log',
  Usage: 'usage',
  Done: 'done',
} as const;

/** What the run had spent by a usage event, and what that one turn spent. */
export interface UsageFigures {
  promptTokens: number;
  completionTokens: number;
  /** The turn that carried the report; null when the event said only the totals. */
  turn: { prompt: number; completion: number } | null;
}

/** A line a tool's server logged while its call ran. */
export interface ServerLogLine {
  level: string;
  text: string;
}

/** What every timeline entry has. */
interface EntryBase {
  /** Stable across updates: the `seq` of the event that started it. */
  key: number;
  /** When it started, in epoch milliseconds. */
  at: number;
  /** The caller's flow step it is inside; empty for the run itself. */
  step: string;
}

/** One entry of the timeline: a run of streamed text gathered into one, a call joined to its result. */
export type TimelineEntry =
  | (EntryBase & { type: 'step'; name: string; text: string })
  | (EntryBase & { type: 'decision'; text: string })
  | (EntryBase & { type: 'turn'; text: string })
  | (EntryBase & { type: 'thinking'; text: string })
  | (EntryBase & { type: 'output'; text: string })
  | (EntryBase & {
      type: 'tool';
      name: string;
      callId: string | null;
      args: string;
      /** Null until the result arrives. */
      result: string | null;
      ok: boolean | null;
      logs: ServerLogLine[];
    })
  | (EntryBase & { type: 'note'; kind: string; text: string })
  | (EntryBase & { type: 'input'; text: string })
  | (EntryBase & { type: 'artifact'; name: string; text: string; uri: string | null })
  | (EntryBase & { type: 'log'; name: string; level: string; text: string })
  | (EntryBase & { type: 'usage'; usage: UsageFigures })
  | (EntryBase & { type: 'done'; ok: boolean; text: string; name: string });

/** A tool entry. */
type ToolEntry = Extract<TimelineEntry, { type: 'tool' }>;

/**
 * Whether a value is a plain object.
 *
 * @param value - Anything.
 * @returns true for an object that is not an array.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false;
}

/**
 * Reads a number, if it is one.
 *
 * @param value - Anything.
 * @returns The number, or 0.
 */
function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Reads a usage event's figures. The event's `usage` is JSON on the wire, so each field is read on its own.
 *
 * @param usage - The event's `usage`.
 * @returns The figures, or null when it carried none.
 */
export function usageOf(usage: unknown): UsageFigures | null {
  if (isRecord(usage) === false) {
    return null;
  }
  const turn = isRecord(usage.turn)
    ? { prompt: numberOf(usage.turn.prompt), completion: numberOf(usage.turn.completion) }
    : null;
  return { promptTokens: numberOf(usage.promptTokens), completionTokens: numberOf(usage.completionTokens), turn };
}

/**
 * Reads an artifact's address.
 *
 * @param link - The event's `link`.
 * @returns Its `uri`, or null.
 */
function uriOf(link: unknown): string | null {
  return isRecord(link) && typeof link.uri === 'string' ? link.uri : null;
}

/**
 * Puts events in order and drops repeats, as a client that reconnects or reads stored events after live ones may
 * receive them twice.
 *
 * @param events - Events in any order, perhaps repeated.
 * @returns Each `seq` once, oldest first.
 */
export function orderedEvents<T extends { seq: number }>(events: readonly T[]): T[] {
  const bySeq = new Map<number, T>();
  for (const event of events) {
    bySeq.set(event.seq, event);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Finds the call a result or a log line belongs to: the one with its id, or else the latest of that name still open.
 *
 * @param calls - Every call so far, oldest first.
 * @param event - The result or the log line.
 * @param isOpenOnly - Whether to match only a call with no result yet.
 * @returns The call, or undefined.
 */
function callFor(calls: readonly ToolEntry[], event: TimelineEvent, isOpenOnly: boolean): ToolEntry | undefined {
  const id = event.id ?? null;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call === undefined || (isOpenOnly && call.result !== null)) {
      continue;
    }
    if (id === null ? call.name === event.name : call.callId === id) {
      return call;
    }
  }
  return undefined;
}

/**
 * Builds the timeline from a run's events: streamed text gathered into one entry per run of it, each tool call
 * joined to its result and its server's log lines, and the rest one entry each.
 *
 * @param events - The run's events, in any order, perhaps repeated.
 * @returns The entries, oldest first.
 */
export function timelineOf(events: readonly TimelineEvent[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const calls: ToolEntry[] = [];
  for (const event of orderedEvents(events)) {
    const base = { key: event.seq, at: event.at, step: event.step };
    const last = entries.at(-1);
    switch (event.kind) {
      case EventKind.Thinking:
      case EventKind.Output: {
        const type = event.kind === EventKind.Thinking ? 'thinking' : 'output';
        if (last !== undefined && last.type === type && last.step === event.step) {
          last.text += event.text;
        } else if (event.text !== '') {
          entries.push({ ...base, type, text: event.text });
        }
        break;
      }
      case EventKind.ToolCall: {
        const call: ToolEntry = {
          ...base,
          type: 'tool',
          name: event.name,
          callId: event.id ?? null,
          args: event.text,
          result: null,
          ok: null,
          logs: [],
        };
        calls.push(call);
        entries.push(call);
        break;
      }
      case EventKind.ToolResult: {
        const call = callFor(calls, event, true);
        if (call === undefined) {
          entries.push({ ...base, type: 'note', kind: event.kind, text: `${event.name}: ${event.text}` });
        } else {
          call.result = event.text;
          call.ok = event.ok;
        }
        break;
      }
      case EventKind.ServerLog: {
        const level = event.level ?? 'info';
        const call = callFor(calls, event, false);
        if (call === undefined) {
          entries.push({ ...base, type: 'log', name: event.name, level, text: event.text });
        } else {
          call.logs.push({ level, text: event.text });
        }
        break;
      }
      case EventKind.Usage: {
        const usage = usageOf(event.usage);
        if (usage !== null) {
          entries.push({ ...base, type: 'usage', usage });
        }
        break;
      }
      case EventKind.Step:
        entries.push({ ...base, type: 'step', name: event.name, text: event.text });
        break;
      case EventKind.Decision:
        entries.push({ ...base, type: 'decision', text: event.text });
        break;
      case EventKind.Turn:
        entries.push({ ...base, type: 'turn', text: event.text });
        break;
      case EventKind.Input:
        entries.push({ ...base, type: 'input', text: event.text });
        break;
      case EventKind.Artifact:
        entries.push({ ...base, type: 'artifact', name: event.name, text: event.text, uri: uriOf(event.link) });
        break;
      case EventKind.Done:
        entries.push({ ...base, type: 'done', ok: event.ok === true, text: event.text, name: event.name });
        break;
      default:
        entries.push({ ...base, type: 'note', kind: event.kind, text: event.text });
    }
  }
  return entries;
}

/**
 * What a run has spent so far, by its latest usage event.
 *
 * @param events - The run's events.
 * @returns The latest figures, or null before its first turn ends.
 */
export function latestUsage(events: readonly TimelineEvent[]): UsageFigures | null {
  const ordered = orderedEvents(events);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const event = ordered[index];
    if (event?.kind === EventKind.Usage) {
      const usage = usageOf(event.usage);
      if (usage !== null) {
        return usage;
      }
    }
  }
  return null;
}
