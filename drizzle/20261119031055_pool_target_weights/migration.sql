ALTER TABLE "pool_targets" ADD COLUMN "weight" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "pool_targets" ADD CONSTRAINT "ck_pool_targets_weight" CHECK ("weight" >= 1);