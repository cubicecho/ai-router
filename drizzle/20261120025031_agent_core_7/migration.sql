ALTER TABLE "conversations" RENAME COLUMN "host_text" TO "system_text";--> statement-breakpoint
UPDATE "override_policies" SET "rules" = "rules" - 'hostPrompt' - 'taskPrompt' WHERE "id" = '00000000-0000-4000-8000-000000000001' AND ("rules"->'hostPrompt') IS DISTINCT FROM 'false'::jsonb;
