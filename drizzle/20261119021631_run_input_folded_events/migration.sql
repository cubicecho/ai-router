ALTER TABLE "run_events" ADD COLUMN "text_ends" integer[];--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "input" jsonb DEFAULT '[]' NOT NULL;