CREATE TABLE "model_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"provider_id" uuid NOT NULL,
	"model" text NOT NULL,
	"input_per_million" double precision NOT NULL,
	"output_per_million" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_model_prices_not_negative" CHECK ("input_per_million" >= 0 and "output_per_million" >= 0)
);
--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "input_price_per_million" double precision;--> statement-breakpoint
ALTER TABLE "pools" ADD COLUMN "output_price_per_million" double precision;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_model_prices_provider_id_model" ON "model_prices" ("provider_id","model");--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_provider_id_providers_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "pools" ADD CONSTRAINT "ck_pools_price" CHECK (("input_price_per_million" is null) = ("output_price_per_million" is null) and coalesce("input_price_per_million", 0) >= 0 and coalesce("output_price_per_million", 0) >= 0);