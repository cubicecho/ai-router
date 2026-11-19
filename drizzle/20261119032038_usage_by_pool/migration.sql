ALTER TABLE "usage_counts" ADD COLUMN "pool_id" uuid;--> statement-breakpoint
ALTER TABLE "usage_counts" ADD COLUMN "pool_name" text;--> statement-breakpoint
ALTER TABLE "usage_counts" DROP CONSTRAINT "uq_usage_counts_key";--> statement-breakpoint
ALTER TABLE "usage_counts" ADD CONSTRAINT "uq_usage_counts_key" UNIQUE NULLS NOT DISTINCT("day","workspace_name","agent_name","pool_name","provider_name","model");--> statement-breakpoint
CREATE INDEX "idx_usage_counts_pool_id" ON "usage_counts" ("pool_id");--> statement-breakpoint
ALTER TABLE "usage_counts" ADD CONSTRAINT "usage_counts_pool_id_pools_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "pools"("id") ON DELETE SET NULL;