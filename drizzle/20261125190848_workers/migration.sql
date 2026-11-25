CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"key_hash" text,
	"key_prefix" text,
	"key_set" boolean GENERATED ALWAYS AS (key_hash is not null) STORED NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"host" text,
	"version" text,
	CONSTRAINT "ck_workers_local_keyless" CHECK (("name" = 'local') = ("key_hash" is null)),
	CONSTRAINT "ck_workers_key_prefix" CHECK (("key_hash" is null) = ("key_prefix" is null))
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "worker_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "worker_id" uuid;--> statement-breakpoint
CREATE INDEX "idx_runs_worker_id" ON "runs" ("worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workers_name" ON "workers" ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workers_key_hash" ON "workers" ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_workers_created_by" ON "workers" ("created_by");--> statement-breakpoint
CREATE INDEX "idx_workspaces_worker_id" ON "workspaces" ("worker_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_worker_id_workers_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_worker_id_workers_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE RESTRICT;--> statement-breakpoint
-- The local worker, the router process itself: the one worker with no key. Nobody renames, deletes or keys it.
INSERT INTO "workers" ("name") VALUES ('local');
