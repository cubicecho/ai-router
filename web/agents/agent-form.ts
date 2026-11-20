/**
 * The agent editor's form: the parts of a `cubicecho.agent/2` document people usually set, read out of a document
 * and written back into it. Everything else the document holds (endpoint, side tasks, hooks, a bundle, extensions,
 * a later 2.x's keys) is kept as it was.
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

/** How the parts are written for the model, as `promptLayout` spells them. Absent is plain. */
export const PromptLayout = { Plain: 'plain', Markdown: 'markdown', Xml: 'xml' } as const;
export type PromptLayout = (typeof PromptLayout)[keyof typeof PromptLayout];

/** The modes an app may use on a part, as `allowedModes` spells them. */
const PromptMode = { Extend: 'extend', Replace: 'replace' } as const;

/** The roles a part may have. A part the form adds is a system one. */
const PART_ROLES: readonly string[] = Object.freeze(['system', 'developer']);
/** The role of a part the form adds. */
const NEW_PART_ROLE = 'system';

/** The keys of a part the form can hold. A part with any other, such as `mode`, is edited in the JSON. */
const FORM_PART_KEYS: ReadonlySet<string> = new Set(['role', 'name', 'content', 'allowedModes']);

/** One part of the prompt, as the form edits it. */
export interface PromptPartValues {
  /** `system` or `developer`, kept as the document had it. */
  role: string;
  name: string;
  content: string;
  /** An app may add a part of its own marked as extending this one. */
  appsExtend: boolean;
  /** An app may add a part of its own that takes this one's place. */
  appsReplace: boolean;
}

/** A part the form adds: a system part an app may extend, as a part that lists no modes is. */
export const NEW_PART: Readonly<PromptPartValues> = Object.freeze({
  role: NEW_PART_ROLE,
  name: '',
  content: '',
  appsExtend: true,
  appsReplace: false,
});

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
  promptLayout: PromptLayout;
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
 * Whether a part's `allowedModes` is one the form can show: absent, or a list of known modes.
 *
 * @param value - The part's `allowedModes`.
 * @returns true when the form's two checkboxes say it.
 */
function isFormModes(value: unknown): boolean {
  const modes: readonly string[] = Object.values(PromptMode);
  return value === undefined || (Array.isArray(value) && value.every((mode) => modes.includes(mode)));
}

/**
 * Whether the form can hold one prompt part: a role, a name, content and the modes apps may use, and nothing else.
 *
 * @param part - One entry of `prompt`.
 * @returns true for a part the form shows whole.
 */
function isFormPart(part: unknown): boolean {
  if (isRecord(part) === false) {
    return false;
  }
  const hasKnownKeys = Object.keys(part).every((key) => FORM_PART_KEYS.has(key));
  const hasRole = part.role === undefined || PART_ROLES.includes(textOf(part.role));
  return (
    hasKnownKeys &&
    hasRole &&
    typeof part.name === 'string' &&
    typeof part.content === 'string' &&
    isFormModes(part.allowedModes)
  );
}

/**
 * Whether the form can hold a document's prompt: a list of parts it shows whole. A part with a `mode`, or anything
 * else, is left for the JSON to edit.
 *
 * @param document - The document.
 * @returns true when the prompt is absent or every part is one the form shows.
 */
export function isPromptEditable(document: Readonly<Record<string, unknown>>): boolean {
  const { prompt } = document;
  if (prompt === undefined) {
    return true;
  }
  return Array.isArray(prompt) && prompt.every(isFormPart);
}

/**
 * Reads one part for the form.
 *
 * @param part - A part {@link isFormPart} accepts.
 * @returns Its fields. A part that lists no modes may be extended, and not replaced.
 */
function partValuesOf(part: Record<string, unknown>): PromptPartValues {
  const modes = Array.isArray(part.allowedModes) ? part.allowedModes : null;
  return {
    role: textOf(part.role) || NEW_PART_ROLE,
    name: textOf(part.name),
    content: textOf(part.content),
    appsExtend: modes === null || modes.includes(PromptMode.Extend),
    appsReplace: modes?.includes(PromptMode.Replace) === true,
  };
}

/**
 * Writes one part from the form.
 *
 * @param values - The part's fields.
 * @returns The part. `allowedModes` is left out where it says what a part without one does: extend only.
 */
function partOf(values: PromptPartValues): Record<string, unknown> {
  const part = { role: values.role, name: values.name.trim(), content: values.content };
  const isDefaultModes = values.appsExtend && values.appsReplace === false;
  if (isDefaultModes) {
    return part;
  }
  const allowedModes = [
    ...(values.appsExtend ? [PromptMode.Extend] : []),
    ...(values.appsReplace ? [PromptMode.Replace] : []),
  ];
  return { ...part, allowedModes };
}

/**
 * Reads the document's layout.
 *
 * @param value - Its `promptLayout`.
 * @returns The layout, plain when absent or not one the router knows.
 */
function layoutOf(value: unknown): PromptLayout {
  return Object.values(PromptLayout).find((layout) => layout === value) ?? PromptLayout.Plain;
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
    prompt: prompt.filter(isRecord).map(partValuesOf),
    promptLayout: layoutOf(document.promptLayout),
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
  const prompt = isPromptEditable(base) ? values.prompt.map(partOf) : base.prompt;
  // Plain is what no layout says, so the key is left out for it.
  const isPlain = values.promptLayout === PromptLayout.Plain;
  return withKeys(base, {
    id: keyText(values.id),
    name: keyText(values.name),
    description: keyText(values.description),
    model: Object.keys(model).length === 0 ? undefined : model,
    prompt: Array.isArray(prompt) && prompt.length === 0 ? undefined : prompt,
    promptLayout: isPlain ? undefined : values.promptLayout,
    tools: Object.keys(tools).length === 0 ? undefined : tools,
  });
}
