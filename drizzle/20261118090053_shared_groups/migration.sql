ALTER TABLE "servers" ADD COLUMN "extra_groups" integer[] DEFAULT '{}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_servers" ADD COLUMN "child_uid" integer DEFAULT nextval('child_uid_seq') NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_servers" ADD COLUMN "install_dir" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_servers_child_uid" ON "workspace_servers" ("child_uid");--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "ck_servers_extra_groups" CHECK (cardinality("extra_groups") <= 8 and 100 <= all("extra_groups") and not (int4range(10000, 19999, '[]') @> any("extra_groups")));--> statement-breakpoint
ALTER TABLE "workspace_servers" ADD CONSTRAINT "ck_workspace_servers_child_uid_range" CHECK ("child_uid" between 10000 and 19999);