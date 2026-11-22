CREATE TABLE "workspace_agent_disabled_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_agent_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_agent_disabled_tools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_agent_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_agent_disabled_servers_workspace_agent_id_server_id" ON "workspace_agent_disabled_servers" ("workspace_agent_id","server_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_agent_disabled_servers_server_id" ON "workspace_agent_disabled_servers" ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_agent_disabled_tools_workspace_agent_id_server_id_tool" ON "workspace_agent_disabled_tools" ("workspace_agent_id","server_id","tool");--> statement-breakpoint
CREATE INDEX "idx_workspace_agent_disabled_tools_server_id" ON "workspace_agent_disabled_tools" ("server_id");--> statement-breakpoint
ALTER TABLE "workspace_agent_disabled_servers" ADD CONSTRAINT "workspace_agent_disabled_servers_6KuozzaTS7GG_fkey" FOREIGN KEY ("workspace_agent_id") REFERENCES "workspace_agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_agent_disabled_servers" ADD CONSTRAINT "workspace_agent_disabled_servers_server_id_servers_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_agent_disabled_tools" ADD CONSTRAINT "workspace_agent_disabled_tools_cdRevjpazWpT_fkey" FOREIGN KEY ("workspace_agent_id") REFERENCES "workspace_agents"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_agent_disabled_tools" ADD CONSTRAINT "workspace_agent_disabled_tools_server_id_servers_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Every agent keeps the reach it had. A workspace's servers become every server one of its agents was granted, beside
-- the entries it already had, each new one an entry that overrides nothing.
INSERT INTO "workspace_servers" ("workspace_id", "server_id")
SELECT DISTINCT "workspace_agents"."workspace_id", "workspace_agent_servers"."server_id"
FROM "workspace_agent_servers"
JOIN "workspace_agents" ON "workspace_agents"."id" = "workspace_agent_servers"."workspace_agent_id"
ON CONFLICT ("workspace_id", "server_id") DO NOTHING;--> statement-breakpoint
-- Then each agent has every one of them turned off that it was not granted.
INSERT INTO "workspace_agent_disabled_servers" ("workspace_agent_id", "server_id")
SELECT "workspace_agents"."id", "workspace_servers"."server_id"
FROM "workspace_agents"
JOIN "workspace_servers" ON "workspace_servers"."workspace_id" = "workspace_agents"."workspace_id"
WHERE NOT EXISTS (
  SELECT 1 FROM "workspace_agent_servers"
  WHERE "workspace_agent_servers"."workspace_agent_id" = "workspace_agents"."id"
    AND "workspace_agent_servers"."server_id" = "workspace_servers"."server_id"
);
