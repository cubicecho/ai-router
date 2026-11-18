CREATE TABLE "pool_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"pool_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"model" text NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"display_name" text,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"strategy" text DEFAULT 'least-busy' NOT NULL,
	"affinity" text DEFAULT 'sticky' NOT NULL,
	"max_load_factor" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_pools_strategy" CHECK ("strategy" in ('least-busy', 'round-robin', 'random')),
	CONSTRAINT "ck_pools_affinity" CHECK ("affinity" in ('sticky', 'none')),
	CONSTRAINT "ck_pools_max_load_factor" CHECK ("max_load_factor" is null or "max_load_factor" >= 1)
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"display_name" text,
	"description" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text,
	"api_key_set" boolean GENERATED ALWAYS AS (api_key is not null and api_key <> '') STORED NOT NULL,
	"headers" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"day" date,
	"workspace_id" uuid,
	"workspace_name" text,
	"agent_id" uuid,
	"agent_name" text,
	"provider_id" uuid,
	"provider_name" text NOT NULL,
	"model" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "uq_usage_counts_key" UNIQUE NULLS NOT DISTINCT("day","workspace_name","agent_name","provider_name","model")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pool_targets_pool_id_provider_id_model" ON "pool_targets" ("pool_id","provider_id","model");--> statement-breakpoint
CREATE INDEX "idx_pool_targets_provider_id" ON "pool_targets" ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pools_name" ON "pools" ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_providers_name" ON "providers" ("name");--> statement-breakpoint
CREATE INDEX "idx_usage_counts_workspace_id" ON "usage_counts" ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_usage_counts_provider_id" ON "usage_counts" ("provider_id");--> statement-breakpoint
CREATE INDEX "idx_usage_counts_day" ON "usage_counts" ("day");--> statement-breakpoint
ALTER TABLE "pool_targets" ADD CONSTRAINT "pool_targets_pool_id_pools_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "pools"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pool_targets" ADD CONSTRAINT "pool_targets_provider_id_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "usage_counts" ADD CONSTRAINT "usage_counts_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "usage_counts" ADD CONSTRAINT "usage_counts_provider_id_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE SET NULL;