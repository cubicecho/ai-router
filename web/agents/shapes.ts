import { RequestError } from '@/lib/gql';
import { isRecord } from '@/lib/is-record';

/** How many spaces a document is indented by when it is shown or edited. */
export const JSON_INDENT = 2;

/** The code a refused save answers with. */
const BAD_USER_INPUT = 'BAD_USER_INPUT';

/** What a new agent's editor starts with: every part a person usually sets, to change. */
export const STARTER_DOCUMENT = {
  spec: 'cubicecho.agent/2',
  id: 'my-agent',
  name: 'My agent',
  description: 'What it is for, in a line.',
  model: { model: 'provider/model', temperature: 0.3 },
  prompt: [{ role: 'system', name: 'identity', content: 'Who it is, and how it helps.' }],
  tools: { maxIterations: 20 },
};

/** What a check or a refused save found in a document. */
export interface DocumentFindings {
  /** Why it can't be saved. Empty when it can. */
  errors: string[];
  /** What is worth a look. Never a reason it can't be saved. */
  warnings: string[];
}

/** The facts the pages show from an agent document. Each is null when the document leaves it out. */
export interface DocumentFacts {
  name: string | null;
  description: string | null;
  model: string | null;
  temperature: number | null;
  /** Each side task and the model it runs on: null for the agent's own, `''` for turned off. */
  tasks: { name: string; model: string | null }[];
}

/**
 * Reads a string, if it is one.
 *
 * @param value - Anything.
 * @returns The string, or null.
 */
function stringOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Reads a list of strings, keeping only the strings.
 *
 * @param value - Anything; a revision's `warnings` or an error's `errors`.
 * @returns The strings, or `[]` when it is no list.
 */
export function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Reads what the pages show from a stored document. A stored document keeps every key it was saved
 * with, so this reads each fact on its own and never trusts the whole shape.
 *
 * @param document - A revision's document.
 * @returns Its facts.
 */
export function factsOf(document: unknown): DocumentFacts {
  const spec = isRecord(document) ? document : {};
  const model = isRecord(spec.model) ? spec.model : {};
  const tasks = isRecord(spec.tasks) ? spec.tasks : {};
  return {
    name: stringOf(spec.name),
    description: stringOf(spec.description),
    model: stringOf(model.model),
    temperature: typeof model.temperature === 'number' ? model.temperature : null,
    tasks: Object.entries(tasks).map(([name, settings]) => ({
      name,
      model: isRecord(settings) ? stringOf(settings.model) : null,
    })),
  };
}

/**
 * Says which model a side task runs on.
 *
 * @param model - The task's `model`.
 * @returns The model id, or what leaving it out or blank means.
 */
export function describeTaskModel(model: string | null): string {
  if (model === null) {
    return "The agent's model";
  }
  return model === '' ? 'Off' : model;
}

/**
 * Names an agent the way a person reads it: its document's name, or the agent's own.
 *
 * @param agent - The agent, with its live document if it has one.
 * @returns The name to show.
 */
export function displayNameOf(agent: { name: string; liveRevision?: { document: unknown } | null }): string {
  return factsOf(agent.liveRevision?.document).name ?? agent.name;
}

/**
 * Writes a document as the editor and the pages show it.
 *
 * @param document - A stored document.
 * @returns It as indented JSON.
 */
export function documentText(document: unknown): string {
  return JSON.stringify(document, null, JSON_INDENT);
}

/**
 * Reads a document typed as JSON.
 *
 * @param text - The text.
 * @returns The document, or what is wrong with the text.
 */
export function parseDocument(text: string): { document: Record<string, unknown> } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { error: `That is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  return isRecord(value) ? { document: value } : { error: 'An agent document is one JSON object.' };
}

/**
 * Reads the reasons out of a refused save.
 *
 * @param error - What the save threw.
 * @returns The errors and warnings the server listed, or null for any other failure.
 */
export function refusalOf(error: unknown): DocumentFindings | null {
  if (error instanceof RequestError === false || error.code !== BAD_USER_INPUT) {
    return null;
  }
  const errors = stringsOf(error.extensions.errors);
  return errors.length === 0 ? null : { errors, warnings: stringsOf(error.extensions.warnings) };
}
