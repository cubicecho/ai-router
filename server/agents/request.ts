import { type AgentLoopOptions, CALL_TOOL, LOAD_TOOLS, RECORD_ARTIFACT } from '@cubicecho/agent-core';
import { z } from 'zod';
import { type RouterSettings, RUN_DEFAULTS } from '../core/defaults.ts';
import { isRecord } from '../core/is-record.ts';
import { UnlistedFields } from '../core/settings.ts';
import type { InputMessage } from '../db/tables/runs.ts';
import type { OverridePolicyRules } from './policy.ts';

/** One message of a conversation, as the loop takes it. */
export type ChatMessage = AgentLoopOptions['messages'][number];
/** One of the app's own tools, as the loop declares it. */
export type AppTool = Extract<NonNullable<AgentLoopOptions['hostTools']>[number], { type: 'function' }>;

/** The names the loop gives its own tools, which an app tool may not take. */
const LOOP_TOOL_NAMES: ReadonlySet<string> = new Set([LOAD_TOOLS, CALL_TOOL, RECORD_ARTIFACT]);
/** OpenAI's rule for a function name. */
const FUNCTION_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
/** The one `tool_choice` the router takes: the agent decides when it calls a tool. */
const TOOL_CHOICE_AUTO = 'auto';

/** What joins the texts of the leading system messages into the host part. */
const HOST_JOIN = '\n\n';

/** The header an answer names the request fields it dropped in, when the router's settings ignore unlisted ones. */
export const IGNORED_HEADER = 'X-AI-Router-Ignored';
/** What joins the dropped fields' names in that header. */
const IGNORED_JOIN = ', ';

/** The roles whose leading messages become the host part. */
const HOST_ROLES: ReadonlySet<string> = new Set(['system', 'developer']);

/** The request field that says how a stream is sent. */
const STREAM_OPTIONS = 'stream_options';
/** The one key of `stream_options` the router reads. */
const INCLUDE_USAGE = 'include_usage';

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
  STREAM_OPTIONS,
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

/** A tool call an assistant message made, as OpenAI writes it. */
const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

/** The messages the router passes to the agent, as OpenAI's chat completions define them. */
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
    tool_calls: z.array(toolCallSchema).optional(),
  }),
  z.object({ role: z.literal('tool'), content: textContent, tool_call_id: z.string().min(1) }),
]);

/** An app's tool, as OpenAI's `tools` defines a function. */
const appToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().regex(FUNCTION_NAME, 'a function name is 1 to 64 letters, digits, _ or -.'),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().nullish(),
  }),
});

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

/** The app's answer to one tool call: a `tool` message. */
export interface ToolAnswer {
  callId: string;
  content: string;
}

/** A chat completion request, read and checked against the agent's override policy. */
export interface RunRequest {
  /** The conversation, without the leading system messages. */
  messages: ChatMessage[];
  /** The `tool` messages the conversation ends with: the app's answers to calls a run handed back. */
  answers: ToolAnswer[];
  /**
   * What this request adds to its run, kept on the run: the app's answers for a resume; otherwise its system and
   * developer messages and the messages after its last assistant one.
   */
  input: InputMessage[];
  /** The app's own tools, from `tools`. */
  appTools: AppTool[];
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
  /** The fields the policy doesn't list that were dropped, in the body's order. Empty unless the settings ignore them. */
  ignored: string[];
}

/**
 * Writes the dropped fields as the `X-AI-Router-Ignored` header's value.
 *
 * @param ignored - The fields, from `RunRequest.ignored`.
 * @returns Their names, comma-separated, or null when none was dropped and the header is left off.
 */
export function ignoredHeaderValue(ignored: readonly string[]): string | null {
  return ignored.length === 0 ? null : ignored.join(IGNORED_JOIN);
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
 * Reads the app's tools.
 *
 * @param body - The parsed body.
 * @param maxAppTools - The most tools it may send: the router's setting.
 * @returns The tools, each named as OpenAI allows and none twice.
 * @throws {@link RequestRefusal} For legacy `functions`, a `tool_choice` other than `auto`, too many tools, a name
 * used twice, or a name the loop keeps for its own tools.
 */
function readAppTools(body: Record<string, unknown>, maxAppTools: number): AppTool[] {
  for (const field of ['functions', 'function_call']) {
    if (body[field] !== undefined && body[field] !== null) {
      throw new RequestRefusal(field, `${field}: send the app's tools as tools, not as the older functions.`);
    }
  }
  const choice = body.tool_choice;
  const isAuto = choice === undefined || choice === null || choice === TOOL_CHOICE_AUTO;
  if (isAuto === false) {
    throw new RequestRefusal(
      'tool_choice',
      'tool_choice: the agent decides when it calls a tool, so only "auto" is taken.',
    );
  }
  const toolsSchema = z.array(appToolSchema).max(maxAppTools, `send at most ${maxAppTools} with one request.`);
  const tools = parseField(toolsSchema.nullish(), body.tools, 'tools') ?? [];
  const names = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    const { name } = tool.function;
    if (LOOP_TOOL_NAMES.has(name)) {
      throw new RequestRefusal(
        `tools.${index}`,
        `tools.${index}: "${name}" is the name of one of the agent's own tools.`,
      );
    }
    if (names.has(name)) {
      throw new RequestRefusal(`tools.${index}`, `tools.${index}: "${name}" is sent twice.`);
    }
    names.add(name);
  }
  return tools.map(({ type, function: { strict, ...fn } }) => ({
    type,
    function: strict === undefined || strict === null ? fn : { ...fn, strict },
  }));
}

/**
 * Reads the `tool` messages a conversation ends with.
 *
 * @param messages - The checked messages.
 * @returns The answers, in order. Empty when the last message is not a tool's.
 */
function trailingAnswers(messages: ParsedMessage[]): ToolAnswer[] {
  const answers: ToolAnswer[] = [];
  for (const message of messages.toReversed()) {
    if (message.role !== 'tool') {
      break;
    }
    answers.unshift({ callId: message.tool_call_id, content: textOf(message.content) });
  }
  return answers;
}

/**
 * Keeps one message a request adds, as text.
 *
 * @param message - A checked message other than an assistant's.
 * @returns The message as the run keeps it.
 */
function inputMessageOf(message: Exclude<ParsedMessage, { role: 'assistant' }>): InputMessage {
  if (message.role === 'tool') {
    return { role: message.role, content: textOf(message.content), toolCallId: message.tool_call_id };
  }
  if (message.role !== 'user') {
    return { role: message.role, content: textOf(message.content) };
  }
  const { content } = message;
  if (typeof content === 'string') {
    return { role: message.role, content };
  }
  const texts = content.flatMap((part) => (part.type === 'text' ? [part.text] : []));
  const images = content.length - texts.length;
  return { role: message.role, content: texts.join(''), ...(images > 0 ? { images } : {}) };
}

/**
 * Picks out what a request adds to its run.
 *
 * @param messages - The checked messages.
 * @param answers - The app's answers the messages end with.
 * @returns The answers, for a resume. Otherwise the leading system and developer messages, which the request sends
 * every time, and the messages after the last assistant one, which are its new turn.
 */
function addedInput(messages: ParsedMessage[], answers: ToolAnswer[]): InputMessage[] {
  const isResume = answers.length > 0;
  const lastAssistant = messages.findLastIndex((message) => message.role === 'assistant');
  const lead = messages.findIndex((message) => isHostMessage(message) === false);
  const added = isResume
    ? messages.slice(messages.length - answers.length)
    : [...messages.slice(0, lead), ...messages.slice(Math.max(lead, lastAssistant + 1))];
  return added.flatMap((message) => (message.role === 'assistant' ? [] : [inputMessageOf(message)]));
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
 * @param unlisted - What the router's settings do with a field the policy doesn't list.
 * @returns The request's sampling settings, and the unlisted fields dropped, in the body's order.
 * @throws {@link RequestRefusal} For a field the policy doesn't allow while the settings refuse those, or a value
 * out of range.
 *
 * @remarks
 * Only the fields reach here that the router doesn't read itself, so ignoring never drops a message, a tool,
 * `response_format` or `ai_router`.
 */
function readSampling(
  body: Record<string, unknown>,
  policy: OverridePolicyRules,
  unlisted: UnlistedFields,
): { sampling: RequestSampling; ignored: string[] } {
  const sampling: RequestSampling = { extraBody: {} };
  const ignored: string[] = [];
  for (const [field, value] of Object.entries(body)) {
    // An unset field, as some clients send it, says nothing.
    const isUnset = value === null || value === undefined;
    if (READ_FIELDS.has(field) || isUnset) {
      continue;
    }
    if (policy.sampling.includes(field) === false) {
      if (unlisted === UnlistedFields.Ignore) {
        ignored.push(field);
        continue;
      }
      throw new RequestRefusal(
        field,
        `${field}: this agent's override policy doesn't let a request set it. An admin can set the router to ignore such fields instead.`,
      );
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
  return { sampling, ignored };
}

/**
 * Checks `stream_options`, of which the router reads only `include_usage`.
 *
 * @param value - The request's `stream_options`.
 * @param unlisted - The router's `unlistedFields` setting.
 * @returns The keys dropped, as `stream_options.<key>`: under `ignore`, every key but `include_usage` that isn't
 * null. None under `refuse`.
 * @throws {@link RequestRefusal} When it isn't an object, `include_usage` isn't a boolean, or, under `refuse`, it
 * holds another key.
 */
function readStreamOptions(value: unknown, unlisted: UnlistedFields): string[] {
  const isIgnoring = unlisted === UnlistedFields.Ignore;
  const shape = { include_usage: z.boolean().nullish() };
  const schema = isIgnoring ? z.looseObject(shape) : z.strictObject(shape);
  const options = parseField(schema.nullish(), value, STREAM_OPTIONS) ?? {};
  if (isIgnoring === false) {
    return [];
  }
  return Object.entries(options)
    .filter(([key, option]) => key !== INCLUDE_USAGE && option !== null && option !== undefined)
    .map(([key]) => `${STREAM_OPTIONS}.${key}`);
}

/**
 * Reads a chat completion request and checks it against the agent's override policy.
 *
 * @param body - The parsed body. Its `model` is the agent, already found.
 * @param policy - The agent's override policy.
 * @param settings - The router's settings, from the snapshot.
 * @returns What the run is built from.
 * @throws {@link RequestRefusal} For anything the router or the policy refuses, naming the field.
 *
 * @remarks
 * Nothing is trimmed quietly. A field the router doesn't read and the policy doesn't list refuses the whole request,
 * or, when the router's `unlistedFields` setting is `ignore`, is dropped and named in `ignored`, for the answer's
 * `X-AI-Router-Ignored` header, as is any key of `stream_options` but `include_usage`. Everything else still refuses: the messages, the tools, `n` above 1 (a run gives
 * one answer), system messages or `response_format` the policy refuses, which would change what the answer is, a
 * bad value of a listed field, and `ai_router`. `parallel_tool_calls` passes through, `user` is recorded, and a
 * field sent as null is read as not sent.
 */
export function readRunRequest(
  body: unknown,
  policy: OverridePolicyRules,
  settings: Readonly<RouterSettings>,
): RunRequest {
  if (isRecord(body) === false) {
    throw new RequestRefusal('body', 'The body must be a JSON object.');
  }
  const appTools = readAppTools(body, settings.maxAppTools);
  const n = parseField(z.int().min(1).nullish(), body.n, 'n');
  if (n !== null && n !== undefined && n > 1) {
    throw new RequestRefusal('n', 'n: a run gives one answer, so n may only be 1.');
  }
  if (Array.isArray(body.messages) === false || body.messages.length === 0) {
    throw new RequestRefusal('messages', 'messages: send the conversation, ending in the question.');
  }
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
  const { sampling, ignored } = readSampling(body, policy, settings.unlistedFields);
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
  ignored.push(...readStreamOptions(body.stream_options, settings.unlistedFields));
  const user = parseField(z.string().max(RUN_DEFAULTS.maxUserLength).nullish(), body.user, 'user') ?? null;
  const answers = trailingAnswers(messages);
  return {
    messages: rest,
    answers,
    input: addedInput(messages, answers),
    appTools,
    hostText,
    taskText: options.task ?? null,
    servers: options.servers ?? null,
    sampling,
    ...requestedStream(body),
    user,
    progress: options.progress === true,
    ignored,
  };
}
