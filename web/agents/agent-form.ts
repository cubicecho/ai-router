/**
 * The agent editor's form: the parts of a `cubicecho.agent/1` document people usually set, read out of a document
 * and written back into it. Everything else the document holds (endpoint, side tasks, hooks, a bundle, extensions,
 * a later 1.x's keys) is kept as it was.
 */

/** Which MCP servers an agent may use: `tools.servers` absent, `[]`, or a list. */
export const ServerReach = {
  /** Absent: every server the router has, now and later. The admin server is never one of them. */
  Every: 'every',
  /** `[]`: none. */
  None: 'none',
  /** A list: exactly these. */
  Chosen: 'chosen',
} as const;
export type ServerReach = (typeof ServerReach)[keyof typeof ServerReach];

/** One part of the prompt, as the form edits it. */
export interface PromptPartValues {
  id: string;
  text: string;
}

/** The form's fields. A blank text field or an empty number leaves its key out of the document. */
export interface AgentFormValues {
  id: string;
  name: string;
  description: string;
  model: string;
  temperature: number | null;
  maxTokens: number | null;
  reasoningEffort: string;
  /** The prompt's parts, in order. Ignored when {@link isPromptEditable} says the form can't hold them. */
  prompt: PromptPartValues[];
  serverReach: ServerReach;
  /** The servers chosen, read only when `serverReach` is `chosen`. */
  servers: string[];
  maxIterations: number | null;
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
 * Reads a string field.
 *
 * @param value - Anything.
 * @returns The string, or empty.
 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Reads a number field.
 *
 * @param value - Anything.
 * @returns The number, or null.
 */
function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Whether the form can hold a document's prompt: a list of parts that each have only an `id` and a `text`. A part
 * with a `ref`, or anything else, is left for the JSON to edit.
 *
 * @param document - The document.
 * @returns true when the prompt is absent or every part is a plain `{ id, text }`.
 */
export function isPromptEditable(document: Readonly<Record<string, unknown>>): boolean {
  const { prompt } = document;
  if (prompt === undefined) {
    return true;
  }
  return (
    Array.isArray(prompt) &&
    prompt.every(
      (part) =>
        isRecord(part) &&
        typeof part.id === 'string' &&
        typeof part.text === 'string' &&
        Object.keys(part).every((key) => key === 'id' || key === 'text'),
    )
  );
}

/**
 * Says which servers a `tools.servers` reaches.
 *
 * @param servers - Its names, or null when it is absent.
 * @returns Every server for absent, none for `[]`, and the chosen ones for a list.
 */
function reachOf(servers: readonly string[] | null): ServerReach {
  if (servers === null) {
    return ServerReach.Every;
  }
  return servers.length === 0 ? ServerReach.None : ServerReach.Chosen;
}

/**
 * Reads the form's fields out of a document.
 *
 * @param document - The document.
 * @returns The fields. Anything the document leaves out is blank.
 */
export function formValuesOf(document: Readonly<Record<string, unknown>>): AgentFormValues {
  const model = isRecord(document.model) ? document.model : {};
  const tools = isRecord(document.tools) ? document.tools : {};
  const servers = Array.isArray(tools.servers)
    ? tools.servers.filter((server): server is string => typeof server === 'string')
    : null;
  const prompt = Array.isArray(document.prompt) && isPromptEditable(document) ? document.prompt : [];
  return {
    id: textOf(document.id),
    name: textOf(document.name),
    description: textOf(document.description),
    model: textOf(model.model),
    temperature: numberOf(model.temperature),
    maxTokens: numberOf(model.maxTokens),
    reasoningEffort: textOf(model.reasoningEffort),
    prompt: prompt.filter(isRecord).map((part) => ({ id: textOf(part.id), text: textOf(part.text) })),
    serverReach: reachOf(servers),
    servers: servers ?? [],
    maxIterations: numberOf(tools.maxIterations),
  };
}

/**
 * Copies an object with some keys set and others removed.
 *
 * @param base - The object as it was.
 * @param changes - Each key's new value; `undefined` removes the key.
 * @returns The copy.
 */
function withKeys(base: Readonly<Record<string, unknown>>, changes: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

/**
 * Reads a text field for the document.
 *
 * @param value - What was typed.
 * @returns The trimmed text, or `undefined` for a blank one, which leaves the key out.
 */
function keyText(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Reads what `tools.servers` should hold.
 *
 * @param values - The form.
 * @returns `undefined` for every server, `[]` for none, or the chosen names.
 */
function serversOf(values: AgentFormValues): string[] | undefined {
  if (values.serverReach === ServerReach.Every) {
    return undefined;
  }
  return values.serverReach === ServerReach.None ? [] : [...values.servers];
}

/**
 * Writes the form's fields into a document, keeping everything the form doesn't show.
 *
 * @param base - The document the form was filled from.
 * @param values - The form.
 * @returns The new document. An object the form emptied (`model`, `tools`) is left out.
 */
export function documentFrom(
  base: Readonly<Record<string, unknown>>,
  values: AgentFormValues,
): Record<string, unknown> {
  const model = withKeys(isRecord(base.model) ? base.model : {}, {
    model: keyText(values.model),
    temperature: values.temperature ?? undefined,
    maxTokens: values.maxTokens ?? undefined,
    reasoningEffort: keyText(values.reasoningEffort),
  });
  const tools = withKeys(isRecord(base.tools) ? base.tools : {}, {
    servers: serversOf(values),
    maxIterations: values.maxIterations ?? undefined,
  });
  const prompt = isPromptEditable(base)
    ? values.prompt.map((part) => ({ id: part.id.trim(), text: part.text }))
    : base.prompt;
  return withKeys(base, {
    id: keyText(values.id),
    name: keyText(values.name),
    description: keyText(values.description),
    model: Object.keys(model).length === 0 ? undefined : model,
    prompt: Array.isArray(prompt) && prompt.length === 0 ? undefined : prompt,
    tools: Object.keys(tools).length === 0 ? undefined : tools,
  });
}
