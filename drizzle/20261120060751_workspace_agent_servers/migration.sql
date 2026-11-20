CREATE TABLE "workspace_agent_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_agent_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_agent_servers_workspace_agent_id_server_id" ON "workspace_agent_servers" ("workspace_agent_id","server_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_agent_servers_server_id" ON "workspace_agent_servers" ("server_id");--> statement-breakpoint
ALTER TABLE "workspace_agent_servers" ADD CONSTRAINT "workspace_agent_servers_F4RH4WORxIlx_fkey" FOREIGN KEY ("workspace_agent_id") REFERENCES "workspace_agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_agent_servers" ADD CONSTRAINT "workspace_agent_servers_server_id_servers_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE;