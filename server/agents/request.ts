import {
  type AgentLoopOptions,
  type AppPart,
  CALL_TOOL,
  LOAD_TOOLS,
  PROGRESS_FIELD,
  parseAppParts,
  RECORD_ARTIFACT,
} from '@cubicecho/agent-core';
import {
  checkLockedFields,
  LOCKED_FIELD_ACTIONS,
  LockedFieldsError,
  type ResolvedAgent,
} from '@cubicecho/agent-core/spec';
import { z } from 'zod';
import { type RouterSettings, RUN_DEFAULTS } from '../core/defaults.ts';
import { isRecord } from '../core/is-record.ts';
import { UnlistedFields } from '../core/settings.ts';
import type { InputMessage } from '../db/tables/runs.ts';

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

/** What joins the texts of the leading system messages into the `app_system` part. */
const SYSTEM_JOIN = '\n\n';

/** The header an answer names the `stream_options` keys it dropped in, when the router's settings ignore them. */
export const IGNORED_HEADER = 'X-AI-Router-Ignored';
/** What joins the dropped fields' names in that header. */
const IGNORED_JOIN = ', ';

/** The roles whose leading messages become the `app_system` part. */
const SYSTEM_ROLES: ReadonlySet<string> = new Set(['system', 'developer']);

/**
 * The request field an app's agent-core options travel under, `agent_core`: agent-core's own name for it, which the
 * answer's progress and warnings use too.
 */
export const AGENT_CORE_FIELD = PROGRESS_FIELD;

/** The field `agent_core` had before agent-core 7, which the router refuses rather than read. */
const OLD_FIELD = 'ai_router';

/** The request field that says how a stream is sent. */
const STREAM_OPTIONS = 'stream_options';
/** The one key of `stream_options` the router reads. */
const INCLUDE_USAGE = 'include_usage';

/** The sampling field the agent format spells as `model.temperature`. */
const TEMPERATURE = 'temperature';
/** The field the agent format spells as `model.reasoningEffort`, which agent-core drops from `extraBody`. */
const REASONING_EFFORT = 'reasoning_effort';
/** The two spellings of the reply's ceiling, `model.maxTokens`. */
const CEILING_FIELDS: readonly string[] = Object.freeze(['max_tokens', 'max_completion_tokens']);

/**
 * The request fields the router reads itself. Anything else an app sends is a setting for the agent's model, and goes
 * to it.
 */
export const READ_FIELDS: ReadonlySet<string> = new Set([
  'model',
  'messages',
  'stream',
  STREAM_OPTIONS,
  'n',
  'user',
  AGENT_CORE_FIELD,
  OLD_FIELD,
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

/** `agent_core`: what an app that knows agent-core may add. */
const agentCoreSchema = z.strictObject({
  /** The app's prompt parts, read by agent-core's `parseAppParts`. */
  prompt: z.unknown().optional(),
  /** Whether the answer carries the run's events. */
  progress: z.boolean().optional(),
  /** Narrows the agent's servers to these. Never widens them. */
  servers: z.array(z.string()).optional(),
});

/** The sampling settings a request sets for the agent's main model. */
export interface RequestSampling {
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
  /** Only fields the agent format has no name for. */
  extraBody: Record<string, unknown>;
}

/** The app's answer to one tool call: a `tool` message. */
export interface ToolAnswer {
  callId: string;
  content: string;
}

/** A chat completion request, read and checked. */
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
  /** The leading system and developer messages' text, for the `app_system` part. Null when there were none. */
  systemText: string | null;
  /** `agent_core.prompt`, the app's parts, for stacking on the agent's. Null when absent. */
  appParts: AppPart[] | null;
  /** `agent_core.servers`, the servers the app narrows the agent to. Null when absent. */
  servers: string[] | null;
  sampling: RequestSampling;
  stream: boolean;
  /** Whether a stream ends with a usage chunk. */
  includeUsage: boolean;
  /** The request's `user`, recorded on the run. */
  user: string | null;
  /** `agent_core.progress`: whether the answer carries the run's events. */
  progress: boolean;
  /** The `stream_options` keys dropped, as `stream_options.<key>`. Empty unless the settings ignore them. */
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
  const lead = messages.findIndex((message) => isSystemMessage(message) === false);
  const added = isResume
    ? messages.slice(messages.length - answers.length)
    : [...messages.slice(0, lead), ...messages.slice(Math.max(lead, lastAssistant + 1))];
  return added.flatMap((message) => (message.role === 'assistant' ? [] : [inputMessageOf(message)]));
}

/**
 * Splits off the leading system and developer messages, which become the `app_system` part.
 *
 * @param messages - The checked messages.
 * @returns Their text, null when there were none, and the conversation after them.
 */
function splitSystem(messages: ParsedMessage[]): { systemText: string | null; rest: ChatMessage[] } {
  const lead: string[] = [];
  for (const message of messages) {
    if (isSystemMessage(message) === false) {
      break;
    }
    lead.push(textOf(message.content));
  }
  return { systemText: lead.length === 0 ? null : lead.join(SYSTEM_JOIN), rest: messages.slice(lead.length) };
}

/**
 * Whether a message is one of those the `app_system` part is made of.
 *
 * @param message - A checked message.
 * @returns true for a system or developer message.
 */
function isSystemMessage(message: ParsedMessage): message is Extract<ParsedMessage, { role: 'system' | 'developer' }> {
  return SYSTEM_ROLES.has(message.role);
}

/**
 * Reads the app's prompt parts with agent-core's `parseAppParts`, refusing what it would drop.
 *
 * @param value - `agent_core.prompt`, as sent.
 * @returns The parts, or null when none were sent.
 * @throws {@link RequestRefusal} For a part agent-core can't use: not a list, a part with no name or content, an
 * unknown role or mode, or `allowedModes`, which is the agent's to set.
 *
 * @remarks
 * A part that breaks the agent's rules (a mode its part doesn't allow, the name `system`) is not refused here:
 * `stackAppParts` drops it, and the answer carries a warning.
 */
function readAppParts(value: unknown): AppPart[] | null {
  if (value === undefined || value === null) {
    return null;
  }
  const { parts, warnings } = parseAppParts(value);
  const [first] = warnings;
  if (first !== undefined) {
    throw new RequestRefusal(`${AGENT_CORE_FIELD}.prompt`, `${AGENT_CORE_FIELD}.${first}`);
  }
  return parts;
}

/**
 * Reads the fields of a request the router doesn't read itself: settings for the agent's model.
 *
 * @param body - The parsed body.
 * @returns The request's sampling settings.
 * @throws {@link RequestRefusal} For a temperature or a ceiling out of range, or two ceilings that disagree.
 *
 * @remarks
 * `temperature`, the ceiling and `reasoning_effort` go to the fields the agent format names for them, and every other
 * field to `extraBody`, so an app's request reaches the model as it would reach any OpenAI-compatible server.
 */
function readSampling(body: Record<string, unknown>): RequestSampling {
  const sampling: RequestSampling = { extraBody: {} };
  for (const [field, value] of Object.entries(body)) {
    // An unset field, as some clients send it, says nothing.
    const isUnset = value === null || value === undefined;
    if (READ_FIELDS.has(field) || isUnset) {
      continue;
    }
    if (field === TEMPERATURE) {
      sampling.temperature = parseField(z.number().min(0).max(2), value, field);
    } else if (CEILING_FIELDS.includes(field)) {
      const ceiling = parseField(z.int().min(1), value, field);
      if (sampling.maxTokens !== undefined && sampling.maxTokens !== ceiling) {
        throw new RequestRefusal(field, `${field}: max_tokens and max_completion_tokens disagree. Send one.`);
      }
      sampling.maxTokens = ceiling;
    } else if (field === REASONING_EFFORT) {
      sampling.reasoningEffort = parseField(z.string(), value, field);
    } else {
      sampling.extraBody[field] = value;
    }
  }
  return sampling;
}

/**
 * Holds a request to the fields its agent locks, with agent-core's `checkLockedFields`.
 *
 * @param body - The parsed body.
 * @param agent - The agent, resolved over the router layer, whose `lockedFields` apply.
 * @param unlisted - The router's `unlistedFields` setting: `ignore` drops a locked field, `refuse` refuses it.
 * @returns The body less any locked field dropped, and the fields dropped, as the request spelled them.
 * @throws {@link RequestRefusal} Under `refuse`, when the request sets a locked field, naming each.
 */
function holdLockedFields(
  body: Record<string, unknown>,
  agent: ResolvedAgent,
  unlisted: UnlistedFields,
): { body: Record<string, unknown>; dropped: readonly string[] } {
  const isIgnoring = unlisted === UnlistedFields.Ignore;
  const onLocked = isIgnoring ? LOCKED_FIELD_ACTIONS.drop : LOCKED_FIELD_ACTIONS.refuse;
  try {
    const { fields, dropped } = checkLockedFields(agent, body, { onLocked });
    return { body: { ...fields }, dropped };
  } catch (error) {
    if (error instanceof LockedFieldsError) {
      const { fields } = error;
      const isOne = fields.length === 1;
      throw new RequestRefusal(
        fields[0] ?? 'body',
        `${fields.join(', ')}: this agent locks ${isOne ? 'this field' : 'these fields'}, so a request may not set ${isOne ? 'it' : 'them'}.`,
      );
    }
    throw error;
  }
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
 * Reads a chat completion request and checks it.
 *
 * @param sent - The parsed body. Its `model` is the agent, already found.
 * @param agent - The agent, resolved over the router layer, for the fields it locks.
 * @param settings - The router's settings, from the snapshot.
 * @returns What the run is built from.
 * @throws {@link RequestRefusal} For anything the router refuses, naming the field.
 *
 * @remarks
 * Every field the router doesn't read itself goes to the agent's model: `temperature`, the ceiling and
 * `reasoning_effort` as the agent format names them, the rest in `extraBody`. `response_format` and `parallel_tool_calls` go there too, and
 * `agent_core.servers` narrows the agent's servers. Nothing is trimmed quietly: a field the agent locks
 * (`model.lockedFields`, checked by agent-core's `checkLockedFields`) and a key of `stream_options` but
 * `include_usage` refuse the request, or, when the router's `unlistedFields` setting is `ignore`, are dropped and
 * named in `ignored`, for the answer's `X-AI-Router-Ignored` header. Everything else refuses: bad messages or tools,
 * `n` above 1 (a run gives one answer), a bad value of a field the router reads, a part in `agent_core.prompt`
 * agent-core can't read, and `ai_router`, the field's old name. System messages and app parts are always taken: the
 * agent's parts are kept by how they are stacked, not by a switch. `user` is recorded, and a field sent as null is
 * read as not sent.
 */
export function readRunRequest(sent: unknown, agent: ResolvedAgent, settings: Readonly<RouterSettings>): RunRequest {
  if (isRecord(sent) === false) {
    throw new RequestRefusal('body', 'The body must be a JSON object.');
  }
  const { body, dropped } = holdLockedFields(sent, agent, settings.unlistedFields);
  const appTools = readAppTools(body, settings.maxAppTools);
  const n = parseField(z.int().min(1).nullish(), body.n, 'n');
  if (n !== null && n !== undefined && n > 1) {
    throw new RequestRefusal('n', 'n: a run gives one answer, so n may only be 1.');
  }
  if (Array.isArray(body.messages) === false || body.messages.length === 0) {
    throw new RequestRefusal('messages', 'messages: send the conversation, ending in the question.');
  }
  const messages = parseField(z.array(messageSchema), body.messages, 'messages');
  const { systemText, rest } = splitSystem(messages);
  if (rest.length === 0) {
    throw new RequestRefusal('messages', 'messages: send at least one message after the system messages.');
  }
  const isOldField = body[OLD_FIELD] !== undefined && body[OLD_FIELD] !== null;
  if (isOldField) {
    throw new RequestRefusal(
      OLD_FIELD,
      `${OLD_FIELD}: this field is now ${AGENT_CORE_FIELD}. Send it under that name.`,
    );
  }
  const options = parseField(agentCoreSchema.nullish(), body[AGENT_CORE_FIELD], AGENT_CORE_FIELD) ?? {};
  const appParts = readAppParts(options.prompt);
  const sampling = readSampling(body);
  const hasResponseFormat = body.response_format !== undefined && body.response_format !== null;
  if (hasResponseFormat) {
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
  const ignored = [...dropped, ...readStreamOptions(body.stream_options, settings.unlistedFields)];
  const user = parseField(z.string().max(RUN_DEFAULTS.maxUserLength).nullish(), body.user, 'user') ?? null;
  const answers = trailingAnswers(messages);
  return {
    messages: rest,
    answers,
    input: addedInput(messages, answers),
    appTools,
    systemText,
    appParts,
    servers: options.servers ?? null,
    sampling,
    ...requestedStream(body),
    user,
    progress: options.progress === true,
    ignored,
  };
}
