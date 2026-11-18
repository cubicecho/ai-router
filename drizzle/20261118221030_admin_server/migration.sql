ALTER TABLE "servers" ADD CONSTRAINT "ck_servers_builtin_source" CHECK (("transport"->>'type' = 'builtin') = ("source"->>'type' = 'builtin'));--> statement-breakpoint
ALTER TABLE "servers" DROP CONSTRAINT "ck_servers_name_reserved", ADD CONSTRAINT "ck_servers_name_reserved" CHECK (("name" = 'ai-router') = ("transport"->>'type' = 'builtin'));--> statement-breakpoint
-- The admin server, the one server with the built-in transport. Nobody may add another, rename it or delete it.
INSERT INTO "servers" ("name", "display_name", "description", "source", "transport") VALUES ('ai-router', 'Admin server', 'The router''s own management, as tools. A workspace''s entry for it grants roles, and an agent reaches it only by naming it.', '{"type":"builtin"}', '{"type":"builtin"}');
