CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"agent_id" uuid,
	"agent_name" text NOT NULL,
	"host_text" text,
	"messages" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_conversations_workspace_id_key" ON "conversations" ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "idx_conversations_expires_at" ON "conversations" ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_conversations_agent_id" ON "conversations" ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runs_conversation_id_going" ON "runs" ("conversation_id") WHERE "status" in ('running', 'waiting');--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_conversation_id_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL;