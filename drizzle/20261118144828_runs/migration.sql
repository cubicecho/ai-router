CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid,
	"workspace_name" text NOT NULL,
	"agent_id" uuid,
	"agent_name" text NOT NULL,
	"revision_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"user" text,
	"stream" boolean NOT NULL,
	"idempotency_key" text,
	"request_hash" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"error" text,
	"answer" jsonb,
	CONSTRAINT "ck_runs_status" CHECK ("status" in ('running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runs_workspace_id_idempotency_key" ON "runs" ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_runs_started_at" ON "runs" ("started_at");--> statement-breakpoint
CREATE INDEX "idx_runs_agent_id" ON "runs" ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_runs_revision_id" ON "runs" ("revision_id");--> statement-breakpoint
CREATE INDEX "idx_runs_status" ON "runs" ("status");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_revision_id_agent_revisions_id_fkey" FOREIGN KEY ("revision_id") REFERENCES "agent_revisions"("id") ON DELETE SET NULL;--> statement-breakpoint
UPDATE "override_policies" SET "rules" = jsonb_set("rules", '{sampling}', ("rules"->'sampling') || '["repeat_penalty"]'::jsonb) WHERE "id" = '00000000-0000-4000-8000-000000000001' AND NOT ("rules"->'sampling') ? 'repeat_penalty';
