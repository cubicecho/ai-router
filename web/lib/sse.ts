/** One message of a `text/event-stream`: its `event` field and its joined `data` lines. */
export interface SseFrame {
  /** The `event` field, or `message` when the frame names none, as the spec has it. */
  event: string;
  /** Every `data` line, joined by a newline. */
  data: string;
}

/** What one read of the stream gave: the frames it finished, and the text left over for the next read. */
export interface SseRead {
  frames: SseFrame[];
  /** The start of a frame that hasn't ended yet. */
  rest: string;
}

/** The event a frame without an `event` field is. */
const DEFAULT_EVENT = 'message';

/**
 * Reads one frame's lines. Comments (`:` lines, the server's keep-alives) and fields other than `event` and `data`
 * are skipped.
 *
 * @param block - The frame's text, without the blank line that ended it.
 * @returns The frame, or null when it held no field worth reading.
 */
function frameOf(block: string): SseFrame | null {
  let event = DEFAULT_EVENT;
  const data: string[] = [];
  let hasField = false;
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) {
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // One space after the colon is part of the syntax, not the value.
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') {
      event = value;
      hasField = true;
    } else if (field === 'data') {
      data.push(value);
      hasField = true;
    }
  }
  return hasField ? { event, data: data.join('\n') } : null;
}

/**
 * Splits what has arrived of an event stream into whole frames.
 *
 * @param buffer - What was left over last time, then what just arrived.
 * @returns The frames that ended, oldest first, and the unfinished rest.
 */
export function readFrames(buffer: string): SseRead {
  const text = buffer.replace(/\r\n/g, '\n');
  const blocks = text.split('\n\n');
  const rest = blocks.pop() ?? '';
  const frames = blocks.flatMap((block) => {
    const frame = frameOf(block);
    return frame === null ? [] : [frame];
  });
  return { frames, rest };
}
