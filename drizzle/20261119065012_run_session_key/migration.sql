ALTER TABLE "runs" ADD COLUMN "session_key" text;--> statement-breakpoint
CREATE INDEX "idx_runs_workspace_id_session_key" ON "runs" ("workspace_id","session_key","started_at") WHERE "session_key" is not null;--> statement-breakpoint
-- A conversation's runs already say which session they belong to.
UPDATE "runs" SET "session_key" = "conversations"."key" FROM "conversations" WHERE "conversations"."id" = "runs"."conversation_id";
