CREATE TABLE "agent_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"agent_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"document" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"override_policy_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL,
	"live_revision_id" uuid,
	"auto_promote" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "override_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"rules" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_revisions_agent_id_number" ON "agent_revisions" ("agent_id","number");--> statement-breakpoint
CREATE INDEX "idx_agent_revisions_created_by" ON "agent_revisions" ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agents_name" ON "agents" ("name");--> statement-breakpoint
CREATE INDEX "idx_agents_override_policy_id" ON "agents" ("override_policy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_override_policies_name" ON "override_policies" ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_agents_workspace_id_agent_id" ON "workspace_agents" ("workspace_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_agents_agent_id" ON "workspace_agents" ("agent_id");--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agent_revisions" ADD CONSTRAINT "agent_revisions_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_revisions" ADD CONSTRAINT "agent_revisions_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_override_policy_id_override_policies_id_fkey" FOREIGN KEY ("override_policy_id") REFERENCES "override_policies"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_live_revision_id_agent_revisions_id_fkey" FOREIGN KEY ("live_revision_id") REFERENCES "agent_revisions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "usage_counts" ADD CONSTRAINT "usage_counts_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspace_agents" ADD CONSTRAINT "workspace_agents_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_agents" ADD CONSTRAINT "workspace_agents_agent_id_agents_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE;--> statement-breakpoint
-- The one override policy every agent uses until policies can be chosen. Its rules are DEFAULT_POLICY_RULES in server/agents/policy.ts; tests/db/seeds.test.ts holds them equal.
INSERT INTO "override_policies" ("id", "name", "description", "rules") VALUES ('00000000-0000-4000-8000-000000000001', 'default', 'An app may add its own instructions, narrow the servers and set sampling settings, but never change the model.', '{"hostPrompt":true,"taskPrompt":true,"narrowServers":true,"sampling":["temperature","max_tokens","max_completion_tokens","top_p","top_k","min_p","presence_penalty","frequency_penalty","repetition_penalty","seed","stop"],"responseFormat":true}');
