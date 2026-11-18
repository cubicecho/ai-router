-- agent-core 5.0 renamed a run event's `step` to `exchange`, and the `step` kind to `exchange`. Stored events are
-- served as they are, so the ones written before are given the new names.
UPDATE "run_events" SET "event" = ("event" - 'step') || jsonb_build_object('exchange', "event"->'step') WHERE "event" ? 'step';--> statement-breakpoint
UPDATE "run_events" SET "kind" = 'exchange', "event" = jsonb_set("event", '{kind}', '"exchange"') WHERE "kind" = 'step';
