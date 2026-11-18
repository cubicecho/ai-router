ALTER TABLE "runs" ADD COLUMN "waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "pending_call_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "resume" jsonb;--> statement-breakpoint
CREATE INDEX "idx_runs_pending_call_ids" ON "runs" USING gin ("pending_call_ids");--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "ck_runs_status", ADD CONSTRAINT "ck_runs_status" CHECK ("status" in ('running', 'waiting', 'completed', 'failed', 'cancelled', 'expired'));