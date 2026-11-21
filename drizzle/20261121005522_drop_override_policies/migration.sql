ALTER TABLE "agents" DROP CONSTRAINT "agents_override_policy_id_override_policies_id_fkey";--> statement-breakpoint
DROP TABLE "override_policies";--> statement-breakpoint
DROP INDEX "idx_agents_override_policy_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "override_policy_id";