CREATE SEQUENCE "public"."child_uid_seq" INCREMENT BY 1 MINVALUE 10000 MAXVALUE 19999 START WITH 10000 CACHE 1;--> statement-breakpoint
CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"server_id" uuid,
	"server_name" text NOT NULL,
	"workspace_id" uuid,
	"workspace_name" text,
	"agent_id" uuid,
	"agent_name" text,
	"run_id" uuid,
	"tool" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"ok" boolean NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "registries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"server_id" uuid NOT NULL,
	"workspace_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_server_secrets_key" UNIQUE NULLS NOT DISTINCT("server_id","workspace_id","kind","name")
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"display_name" text,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"source" jsonb NOT NULL,
	"transport" jsonb NOT NULL,
	"env" jsonb DEFAULT '{}' NOT NULL,
	"env_meta" jsonb DEFAULT '{}' NOT NULL,
	"idle_timeout_ms" integer,
	"call_timeout_ms" integer,
	"child_uid" integer DEFAULT nextval('child_uid_seq') NOT NULL,
	"install_dir" text,
	"oauth" jsonb,
	"signed_in" boolean GENERATED ALWAYS AS (oauth is not null and oauth ? 'tokens') STORED NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_servers_name_reserved" CHECK ("name" <> 'ai-router'),
	CONSTRAINT "ck_servers_child_uid_range" CHECK ("child_uid" between 10000 and 19999)
);
--> statement-breakpoint
CREATE TABLE "workspace_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"env" jsonb DEFAULT '{}' NOT NULL,
	"args" jsonb,
	"url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_activity_at" ON "activity" ("at");--> statement-breakpoint
CREATE INDEX "idx_activity_server_id" ON "activity" ("server_id");--> statement-breakpoint
CREATE INDEX "idx_activity_workspace_id" ON "activity" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_registries_name" ON "registries" ("name");--> statement-breakpoint
CREATE INDEX "idx_server_secrets_workspace_id" ON "server_secrets" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_servers_name" ON "servers" ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_servers_child_uid" ON "servers" ("child_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_servers_workspace_id_server_id" ON "workspace_servers" ("workspace_id","server_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_servers_server_id" ON "workspace_servers" ("server_id");--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_server_id_servers_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "server_secrets" ADD CONSTRAINT "server_secrets_server_id_servers_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "server_secrets" ADD CONSTRAINT "server_secrets_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_servers" ADD CONSTRAINT "workspace_servers_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_servers" ADD CONSTRAINT "workspace_servers_server_id_servers_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE;--> statement-breakpoint
-- The official MCP registry, so there is something to browse on a new router.
INSERT INTO "registries" ("name", "url") VALUES ('official', 'https://registry.modelcontextprotocol.io');
