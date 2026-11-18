import { fold, type RunEvent } from '@cubicecho/agent-core';
import { eq } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { Context } from '../core/context.ts';
import { RUN_DEFAULTS } from '../core/defaults.ts';
import { badInput, notFound } from '../core/errors.ts';
import { runs } from '../db/tables/runs.ts';
import { objectType } from '../graphql/object-type.ts';

const { eventPageSize, maxEventPageSize } = RUN_DEFAULTS;

/**
 * The event type, live or stored. Its name is the subscription's from before events were stored, kept so clients
 * keep working.
 */
const EVENT_TYPE_SDL = `
  "One thing a run did: agent-core's RunEvent, unchanged, from the subscription or from the run's stored events."
  type LiveRunEvent {
    "The run it belongs to."
    runId: UUID!
    "Its place in the run, from 1, for ordering and dropping repeats."
    seq: Int!
    "When it happened, in milliseconds since the epoch."
    at: Float!
    "What happened: turn, thinking, output, tool-call, tool-result, notice, usage, done and the rest of agent-core's kinds."
    kind: String!
    "The delta, the arguments, the result or the reason, whatever the kind carries."
    text: String!
    "The tool's name on the tool kinds; otherwise empty."
    name: String!
    "The call's id on the tool kinds."
    id: String
    "The caller's flow step it happened in. Empty for a run with none."
    step: String!
    "The outcome on tool-result and done."
    ok: Boolean
    "The running totals on usage."
    usage: JSON
    "What a call produced, on artifact."
    link: JSON
    "The server's level, on server-log."
    level: String
    "What load_tools loaded, on its tool-result."
    loads: JSON
  }
`;

/** The subscription field. */
const RUN_EVENTS_FIELD = `
    "Follows a run: every event it has stored, then each one as it happens, ending with its done, with no gap and no repeat. afterSeq starts after an event the client already has."
    runEvents(runId: UUID!, afterSeq: Int): LiveRunEvent!
`;

/** A run's stored events, on the generated type. */
const RUN_FIELD_SDL = `
  extend type Run {
    "Its events, oldest first, from after afterSeq. folded joins each stretch of thinking or output into one event. Select id with it."
    events(afterSeq: Int, limit: Int, folded: Boolean): [LiveRunEvent!]!
  }
`;

/** What `Run.events` takes. */
interface EventsArgs {
  afterSeq?: number | null;
  limit?: number | null;
  folded?: boolean | null;
}

/** What the subscription yields: the field's value under its name, so the default resolver reads it. */
interface RunEventPayload {
  runEvents: RunEvent;
}

/**
 * Wraps a run's events as the subscription's payloads.
 *
 * @param events - The events.
 * @returns One payload per event.
 */
async function* payloads(events: AsyncIterable<RunEvent>): AsyncGenerator<RunEventPayload> {
  for await (const event of events) {
    yield { runEvents: event };
  }
}

/**
 * Adds the `runEvents` subscription, which people follow a run with, and `Run.events`, which reads its stored events.
 *
 * @param schema - Schema to extend.
 * @returns The extended schema.
 *
 * @remarks
 * The field keeps the default resolver and does its work in `subscribe`, which is what graphql-casl guards on a
 * subscription field with no resolver of its own. Only people reach it: the permission map refuses a key.
 */
export function applyRunsExtension(schema: GraphQLSchema): GraphQLSchema {
  const root =
    schema.getSubscriptionType() === null || schema.getSubscriptionType() === undefined
      ? `type Subscription {${RUN_EVENTS_FIELD}}\nextend schema { subscription: Subscription }`
      : `extend type Subscription {${RUN_EVENTS_FIELD}}`;
  const extended = extendSchema(schema, parse(`${EVENT_TYPE_SDL}\n${RUN_FIELD_SDL}\n${root}`));
  const fields = objectType(extended, 'Subscription').getFields();

  fields.runEvents.subscribe = async (
    _parent: unknown,
    args: { runId: string; afterSeq?: number | null },
    ctx: Context,
  ) => {
    const [row] = await ctx.db.select({ id: runs.id }).from(runs).where(eq(runs.id, args.runId));
    if (row === undefined) {
      throw notFound('Run not found.');
    }
    const afterSeq = args.afterSeq ?? 0;
    return payloads(ctx.runs.bus.watch(args.runId, { afterSeq, signal: ctx.request?.signal }));
  };

  const runFields = objectType(extended, 'Run').getFields();
  runFields.events.resolve = async (parent: { id?: string }, args: EventsArgs, ctx: Context) => {
    if (parent.id === undefined) {
      throw badInput("Select the run's id alongside events.");
    }
    const limit = args.limit ?? eventPageSize;
    const isInRange = limit >= 1 && limit <= maxEventPageSize;
    if (isInRange === false) {
      throw badInput(`events: limit is 1 to ${maxEventPageSize}.`);
    }
    const events = await ctx.runs.bus.events(parent.id, args.afterSeq ?? 0, limit);
    return args.folded === true ? fold(events) : events;
  };

  return extended;
}
