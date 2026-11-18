import type { RunEvent } from '@cubicecho/agent-core';
import { eq } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { Context } from '../core/context.ts';
import { notFound } from '../core/errors.ts';
import { RunStatus, runs } from '../db/tables/runs.ts';
import { objectType } from '../graphql/object-type.ts';

/** The event type, named apart from the `run_events` rows phase 7 stores and drizzle-graphql will name `RunEvent`. */
const EVENT_TYPE_SDL = `
  "One thing a live run did: agent-core's RunEvent, unchanged."
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
    "Follows a live run: what it has done so far, then each event as it happens, ending with its done. Events are not stored yet, so a run that ended a while ago gives none."
    runEvents(runId: UUID!): LiveRunEvent!
`;

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
 * Adds the `runEvents` subscription, which people follow a live run with.
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
  const extended = extendSchema(schema, parse(`${EVENT_TYPE_SDL}\n${root}`));
  const fields = objectType(extended, 'Subscription').getFields();

  fields.runEvents.subscribe = async (_parent: unknown, args: { runId: string }, ctx: Context) => {
    const [row] = await ctx.db.select({ status: runs.status }).from(runs).where(eq(runs.id, args.runId));
    if (row === undefined) {
      throw notFound('Run not found.');
    }
    const signal = ctx.request?.signal;
    const isHeld = row.status === RunStatus.Running || ctx.runs.bus.history(args.runId).length > 0;
    // The bus waits for a run it doesn't know yet; an ended run it no longer holds has nothing left to say.
    return payloads(isHeld ? ctx.runs.bus.watch(args.runId, signal) : (async function* () {})());
  };

  return extended;
}
