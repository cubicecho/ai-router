import type { AgentLoopOptions } from '@cubicecho/agent-core';
import { z } from 'zod';
import { RUN_DEFAULTS } from '../core/defaults.ts';
import { isRecord } from '../core/is-record.ts';
import type { OverridePolicyRules } from './policy.ts';

/** One message of a conversation, as the loop takes it. */
export type ChatMessage = AgentLoopOptions['messages'][number];

/** What joins the texts of the leading system messages into the host part. */
const HOST_JOIN = '\n\n';

/** The roles whose leading messages become the host part. */
const HOST_ROLES: ReadonlySet<string> = new Set(['system', 'developer']);

/** The sampling field the agent format spells as `model.temperature`. */
const TEMPERATURE = 'temperature';
/** The two spellings of the reply's ceiling, `model.maxTokens`. Every other allowed field goes into `extraBody`. */
const CEILING_FIELDS: readonly string[] = Object.freeze(['max_tokens', 'max_completion_tokens']);

/**
 * The request fields the router reads itself. Anything else an app sends is an override, which only the agent's
 * policy can allow.
 */
const READ_FIELDS: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'stream',
  'stream_options',
  'n',
  'user',
  'ai_router',
  'response_format',
  'parallel_tool_calls',
  'tools',
  'tool_choice',
  'functions',
  'function_call',
]);

/** What a refusal of app tools says, until phase 7 brings them. */
const NO_APP_TOOLS = "app tools aren't supported yet: the agent runs with its own tools only.";

/** A request the router refuses before any run starts: 400, in OpenAI's error envelope. */
export class RequestRefusal extends Error {
  /** The request field it is about, as OpenAI's `param`. */
  readonly param: string;

  /**
   * Builds the refusal.
   *
   * @param param - The field, by its wire name.
   * @param message - What the app is told. It names the field.
   */
  constructor(param: string, message: string) {
    super(message);
    this.name = 'RequestRefusal';
    this.param = param;
  }
}

/** Text, or the text parts of a message's content. */
const textPart = z.object({ type: z.literal('text'), text: z.string() });
const imagePart = z.object({
  type: z.literal('image_url'),
  image_url: z.object({ url: z.string(), detail: z.enum(['auto', 'low', 'high']).optional() }),
});
const textContent = z.union([z.string(), z.array(textPart)]);

/** The messages the router passes to the agent, as OpenAI's chat completions define them. App tools are phase 7. */
const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: textContent, name: z.string().optional() }),
  z.object({ role: z.literal('developer'), content: textContent, name: z.string().optional() }),
  z.object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(z.union([textPart, imagePart]))]),
    name: z.string().optional(),
  }),
  z.object({
    role: z.literal('assistant'),
    content: z.union([textContent, z.null()]).optional(),
    name: z.string().optional(),
  }),
]);

/** A message as the schema read it. */
type ParsedMessage = z.infer<typeof messageSchema>;

/** `ai_router`: what an app that knows the router may add. */
const routerOptionsSchema = z.strictObject({
  /** A task layer's text. */
  task: z.string().optional(),
  /** Whether the answer carries the run's events. */
  progress: z.boolean().optional(),
  /** Narrows the agent's servers to these. Never widens them. */
  servers: z.array(z.string()).optional(),
});

/** The sampling settings a request sets for the agent's main model. */
export interface RequestSampling {
  temperature?: number;
  maxTokens?: number;
  /** Only fields the agent format has no name for. */
  extraBody: Record<string, unknown>;
}

/** A chat completion request, read and checked against the agent's override policy. */
export interface RunRequest {
  /** The conversation, without the leading system messages. */
  messages: ChatMessage[];
  /** The leading system and developer messages' text, for the host part. Null when there were none. */
  hostText: string | null;
  /** `ai_router.task`, for the task part. Null when absent. */
  taskText: string | null;
  /** `ai_router.servers`, the servers the app narrows the agent to. Null when absent. */
  servers: string[] | null;
  sampling: RequestSampling;
  stream: boolean;
  /** Whether a stream ends with a usage chunk. */
  includeUsage: boolean;
  /** The request's `user`, recorded on the run. */
  user: string | null;
  /** `ai_router.progress`: whether the answer carries the run's events. */
  progress: boolean;
}

/**
 * Reads the agent a request names.
 *
 * @param body - The parsed body.
 * @returns Its `model`, or null when it names none.
 */
export function requestedAgent(body: unknown): string | null {
  return isRecord(body) && typeof body.model === 'string' && body.model !== '' ? body.model : null;
}

/**
 * Reads whether a request asks for a stream, and for usage at its end, before anything else is checked.
 *
 * @param body - The parsed body.
 * @returns `stream` and `stream_options.include_usage`, false when not set.
 */
export function requestedStream(body: unknown): { stream: boolean; includeUsage: boolean } {
  const stream = isRecord(body) && body.stream === true;
  const options = isRecord(body) && isRecord(body.stream_options) ? body.stream_options : {};
  return { stream, includeUsage: stream && options.include_usage === true };
}

/**
 * Checks a value against a schema, refusing the request in the field's name.
 *
 * @param schema - The schema.
 * @param value - The value.
 * @param param - The field, for the message.
 * @returns The parsed value.
 * @throws {@link RequestRefusal} When it doesn't match.
 */
function parseField<T extends z.ZodType>(schema: T, value: unknown, param: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success === false) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? param : `${param}.${issue.path.join('.')}`;
    throw new RequestRefusal(param, `${where}: ${issue?.message ?? 'not valid.'}`);
  }
  return parsed.data;
}

/**
 * Joins a system message's text.
 *
 * @param content - Its content: a string or text parts.
 * @returns The text.
 */
function textOf(content: z.infer<typeof textContent>): string {
  return typeof content === 'string' ? content : content.map((part) => part.text).join('');
}

/**
 * Refuses the history of an app's own tool loop, which phase 7 brings.
 *
 * @param messages - The raw `messages`.
 * @throws {@link RequestRefusal} For a `tool` or `function` message, or an assistant message with calls.
 */
function refuseToolHistory(messages: unknown[]): void {
  for (const [index, message] of messages.entries()) {
    if (isRecord(message) === false) {
      continue;
    }
    const isToolResult = message.role === 'tool' || message.role === 'function';
    const callsTools =
      message.role === 'assistant' &&
      ((Array.isArray(message.tool_calls) && message.tool_calls.length > 0) || isRecord(message.function_call));
    if (isToolResult || callsTools) {
      throw new RequestRefusal(`messages.${index}`, `messages.${index}: ${NO_APP_TOOLS}`);
    }
  }
}

/**
 * Splits off the leading system and developer messages, which become the host part.
 *
 * @param messages - The checked messages.
 * @returns The host text, null when there were none, and the conversation after them.
 */
function splitHost(messages: ParsedMessage[]): { hostText: string | null; rest: ChatMessage[] } {
  const lead: string[] = [];
  for (const message of messages) {
    if (isHostMessage(message) === false) {
      break;
    }
    lead.push(textOf(message.content));
  }
  return { hostText: lead.length === 0 ? null : lead.join(HOST_JOIN), rest: messages.slice(lead.length) };
}

/**
 * Whether a message is one of those a host part is made of.
 *
 * @param message - A checked message.
 * @returns true for a system or developer message.
 */
function isHostMessage(message: ParsedMessage): message is Extract<ParsedMessage, { role: 'system' | 'developer' }> {
  return HOST_ROLES.has(message.role);
}

/**
 * Reads the sampling fields of a request, as the policy allows them.
 *
 * @param body - The parsed body.
 * @param policy - The agent's override policy.
 * @returns The request's sampling settings.
 * @throws {@link RequestRefusal} For a field the policy doesn't allow, or a value out of range.
 */
function readSampling(body: Record<string, unknown>, policy: OverridePolicyRules): RequestSampling {
  const sampling: RequestSampling = { extraBody: {} };
  for (const [field, value] of Object.entries(body)) {
    // An unset field, as some clients send it, says nothing.
    const isUnset = value === null || value === undefined;
    if (READ_FIELDS.has(field) || isUnset) {
      continue;
    }
    if (policy.sampling.includes(field) === false) {
      throw new RequestRefusal(field, `${field}: this agent's override policy doesn't let a request set it.`);
    }
    if (field === TEMPERATURE) {
      sampling.temperature = parseField(z.number().min(0).max(2), value, field);
    } else if (CEILING_FIELDS.includes(field)) {
      const ceiling = parseField(z.int().min(1), value, field);
      if (sampling.maxTokens !== undefined && sampling.maxTokens !== ceiling) {
        throw new RequestRefusal(field, `${field}: max_tokens and max_completion_tokens disagree. Send one.`);
      }
      sampling.maxTokens = ceiling;
    } else {
      sampling.extraBody[field] = value;
    }
  }
  return sampling;
}

/**
 * Reads a chat completion request and checks it against the agent's override policy.
 *
 * @param body - The parsed body. Its `model` is the agent, already found.
 * @param policy - The agent's override policy.
 * @returns What the run is built from.
 * @throws {@link RequestRefusal} For anything the router or the policy refuses, naming the field.
 *
 * @remarks
 * Nothing is quietly trimmed: a field the policy doesn't allow refuses the whole request. `response_format` follows
 * the policy, `parallel_tool_calls` passes through, `user` is recorded, and `n` above 1 is refused, because a run
 * gives one answer. A field sent as null is read as not sent.
 */
export function readRunRequest(body: unknown, policy: OverridePolicyRules): RunRequest {
  if (isRecord(body) === false) {
    throw new RequestRefusal('body', 'The body must be a JSON object.');
  }
  const hasAppTools = (Array.isArray(body.tools) && body.tools.length > 0) || Array.isArray(body.functions);
  if (hasAppTools) {
    throw new RequestRefusal('tools', `tools: ${NO_APP_TOOLS}`);
  }
  for (const field of ['tool_choice', 'function_call']) {
    if (body[field] !== undefined && body[field] !== null) {
      throw new RequestRefusal(field, `${field}: ${NO_APP_TOOLS}`);
    }
  }
  const n = parseField(z.int().min(1).nullish(), body.n, 'n');
  if (n !== null && n !== undefined && n > 1) {
    throw new RequestRefusal('n', 'n: a run gives one answer, so n may only be 1.');
  }
  if (Array.isArray(body.messages) === false || body.messages.length === 0) {
    throw new RequestRefusal('messages', 'messages: send the conversation, ending in the question.');
  }
  refuseToolHistory(body.messages);
  const messages = parseField(z.array(messageSchema), body.messages, 'messages');
  const { hostText, rest } = splitHost(messages);
  if (rest.length === 0) {
    throw new RequestRefusal('messages', 'messages: send at least one message after the system messages.');
  }
  if (hostText !== null && policy.hostPrompt === false) {
    throw new RequestRefusal('messages', "messages: this agent's override policy doesn't take system messages.");
  }
  const options = parseField(routerOptionsSchema.nullish(), body.ai_router, 'ai_router') ?? {};
  if (options.task !== undefined && policy.taskPrompt === false) {
    throw new RequestRefusal('ai_router.task', "ai_router.task: this agent's override policy doesn't take a task.");
  }
  if (options.servers !== undefined && policy.narrowServers === false) {
    throw new RequestRefusal(
      'ai_router.servers',
      "ai_router.servers: this agent's override policy doesn't let a request narrow its servers.",
    );
  }
  const sampling = readSampling(body, policy);
  const hasResponseFormat = body.response_format !== undefined && body.response_format !== null;
  if (hasResponseFormat) {
    if (policy.responseFormat === false) {
      throw new RequestRefusal(
        'response_format',
        "response_format: this agent's override policy doesn't let a request set it.",
      );
    }
    sampling.extraBody.response_format = parseField(
      z.record(z.string(), z.unknown()),
      body.response_format,
      'response_format',
    );
  }
  const hasParallelChoice = body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== null;
  if (hasParallelChoice) {
    sampling.extraBody.parallel_tool_calls = parseField(z.boolean(), body.parallel_tool_calls, 'parallel_tool_calls');
  }
  parseField(z.boolean().nullish(), body.stream, 'stream');
  parseField(
    z.strictObject({ include_usage: z.boolean().optional() }).nullish(),
    body.stream_options,
    'stream_options',
  );
  const user = parseField(z.string().max(RUN_DEFAULTS.maxUserLength).nullish(), body.user, 'user') ?? null;
  return {
    messages: rest,
    hostText,
    taskText: options.task ?? null,
    servers: options.servers ?? null,
    sampling,
    ...requestedStream(body),
    user,
    progress: options.progress === true,
  };
}
