CREATE TABLE "run_events" (
	"run_id" uuid,
	"seq" integer,
	"kind" text NOT NULL,
	"event" jsonb NOT NULL,
	CONSTRAINT "pk_run_events" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE;