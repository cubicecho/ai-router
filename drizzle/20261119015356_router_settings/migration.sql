CREATE TABLE "settings" (
	"id" text PRIMARY KEY DEFAULT 'router',
	"values" jsonb DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_settings_singleton" CHECK ("id" = 'router')
);
