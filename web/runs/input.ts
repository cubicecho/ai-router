/** The roles a run's input messages have, as the router keeps them. */
export const InputRole = {
  System: 'system',
  Developer: 'developer',
  User: 'user',
  Tool: 'tool',
} as const;
export type InputRole = (typeof InputRole)[keyof typeof InputRole];

/** What each role is called on the page. */
export const INPUT_ROLE_LABELS: Readonly<Record<InputRole, string>> = Object.freeze({
  system: 'System',
  developer: 'Developer',
  user: 'User',
  tool: 'Tool answer',
});

/** One message a request added to a run: the run's `input`, read off the wire. */
export interface InputMessage {
  role: InputRole;
  content: string;
  /** The handed-back call a tool answer answers; null for any other role. */
  toolCallId: string | null;
  /** How many images a user message carried. */
  images: number;
}

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
 * Reads a role, if it is one.
 *
 * @param value - Anything.
 * @returns The role, or undefined.
 */
function roleOf(value: unknown): InputRole | undefined {
  return Object.values(InputRole).find((role) => role === value);
}

/**
 * Reads a run's input. The `input` column is JSON on the wire, so each message is read field by field, and one
 * that isn't a message is left out.
 *
 * @param input - The run's `input`.
 * @returns Its messages, in the order the requests added them.
 */
export function inputMessagesOf(input: unknown): InputMessage[] {
  if (Array.isArray(input) === false) {
    return [];
  }
  return input.flatMap((message: unknown) => {
    if (isRecord(message) === false) {
      return [];
    }
    const role = roleOf(message.role);
    const { content } = message;
    if (role === undefined || typeof content !== 'string') {
      return [];
    }
    return [
      {
        role,
        content,
        toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : null,
        images: typeof message.images === 'number' ? message.images : 0,
      },
    ];
  });
}
