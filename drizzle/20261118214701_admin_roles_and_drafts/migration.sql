ALTER TABLE "agent_revisions" ADD COLUMN "saved_by_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_revisions" ADD COLUMN "saved_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_revisions" ADD COLUMN "based_on_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_servers" ADD COLUMN "roles" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_agent_revisions_saved_by_workspace_id" ON "agent_revisions" ("saved_by_workspace_id");--> statement-breakpoint
CREATE INDEX "idx_agent_revisions_saved_by_agent_id" ON "agent_revisions" ("saved_by_agent_id");--> statement-breakpoint
CREATE INDEX "idx_agent_revisions_based_on_id" ON "agent_revisions" ("based_on_id");--> statement-breakpoint
ALTER TABLE "agent_revisions" ADD CONSTRAINT "agent_revisions_saved_by_workspace_id_workspaces_id_fkey" FOREIGN KEY ("saved_by_workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agent_revisions" ADD CONSTRAINT "agent_revisions_saved_by_agent_id_agents_id_fkey" FOREIGN KEY ("saved_by_agent_id") REFERENCES "agents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "agent_revisions" ADD CONSTRAINT "agent_revisions_based_on_id_agent_revisions_id_fkey" FOREIGN KEY ("based_on_id") REFERENCES "agent_revisions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspace_servers" ADD CONSTRAINT "ck_workspace_servers_roles" CHECK ("roles" <@ array['agents:read', 'agents:manage', 'models:read', 'models:manage', 'servers:read', 'servers:manage', 'servers:operate', 'runs:read']::text[]);