# AGENTS.md — ai-router

ai-router gives every app on a network **agents**, through one address and one key per app.

- **`/v1` is the agents endpoint.** It looks like any OpenAI-compatible server, but every model
  it lists is an agent: a `cubicecho.agent/2` document naming a model, a prompt and tools.
- **Models and MCP servers are internal.** The router keeps the providers, pools and servers its
  agents use, and serves no raw model or tool endpoint. Apps that run their own loop keep using
  llm-router and mcp-router.
- **The key decides what each app sees.** It belongs to a **workspace**, which lists the agents
  that app may run, and configures their servers for its runs.

llm-router and mcp-router (`../llm-router`, `../mcp/mcp-router`) stay in service. Their model and
tool code is the reference to port from, not a dependency.

**Status: phases 1 to 3, 5 to 7 and 9 are built:** the scaffold, models, tools, agents and their
revisions, runs on `/v1` with app tools, progress events, run records at `/runs` and
conversations, and the admin server with roles and drafts. The apps are moving over (phase 8).
What comes next is in the GitHub issues and `PLAN.md`'s later list.

- **Concepts, actors, lifecycles and invariants:** [`.agents/domain-model.md`](.agents/domain-model.md).
  Use its terms everywhere.
- **Decisions and the order of work:** [`PLAN.md`](PLAN.md).
- **The agent format:** `../agent-core/docs/agent-spec-v2.md`, and how its prompt is stacked
  with an app's, `../agent-core/docs/agent-prompt-spec-v2.md` (ai-router's part is in
  `prompt-implementations.md` there), implemented in
  `@cubicecho/agent-core` (`src/spec/`).
- **How a cubicecho backend is built:** the `cubicecho_backend` skill (single-operator
  archetype), `cubicecho_typescript` and `coding-standards`. Load all three from the skills server
  before writing code. This file holds only what is specific to ai-router.

## Stack and layout

Laid out as a single-operator cubicecho service with no tenancy, shared by several users with
roles:
- Node 26, running TypeScript directly.
- graphql-yoga on Express 5.
- Drizzle `1.0.0-rc.5`, with `@vantreeseba/drizzle-graphql` and `@vantreeseba/graphql-casl`.
- better-auth for people's sessions, with its endpoints served as GraphQL by
  `@cubicecho/graphql-better-auth`. Users sign in through OIDC (heautou), with no magic links,
  SMTP or passwords. Under `SECURE_LOCAL_NET`, whoever opens the UI is signed in as the admin
  automatically, and nothing else changes.
- Workspace keys are the router's own `workspace_keys` table, not better-auth's api-key plugin:
  only each key's SHA-256 is stored, and keys are checked against the snapshot.
- zod and Vitest.
- Postgres, always: `DATABASE_URL` is required. PGlite runs only in the tests. `npm run db:up`
  starts a local Postgres for development (`docker-compose.dev.yml`).
- Docker on `node:26-slim`, with `run-as-child` (`docker/run-as-child.c`) built in.

One package: `server/`, `web/` (Vite, cubeui, GraphQL codegen), `tests/` (the same folders as
`server/`), `drizzle/` (migrations, committed), `docker/`, `scripts/`.

| `server/` folder | Holds | May import |
| --- | --- | --- |
| `core/` | config, defaults, wire constants, errors, validation, name rules, the settings' rules, preflight, context | nothing here, except types for `context.ts` |
| `db/` | the Postgres client, the advisory lock, migrations, waiting for Postgres, the tables, the snapshot | `core` |
| `auth/` | better-auth, keys, the caller, roles, the trusted-network sign-in, rate limiting, and their GraphQL fields | `core`, `db`, `sso`, `graphql/object-type`, `http/sso` (for its path) |
| `sso/` | pairing with an OIDC provider from the UI | `core`, `db`, `auth` |
| `settings/` | the router's settings: reading and changing them over GraphQL | `core`, `db`, `graphql/object-type` |
| `models/` | providers, pools, the balancer, forwarding a run's model calls, usage (phase 2) | `core`, `db`, `auth` |
| `tools/` | the child-user check; later registries, the installer, servers, instances, activity | `core`, `db`, `auth` |
| `agents/` | revisions, layers, override policies, reach, runs, conversations, the `/v1` agents endpoint, `/runs`, the `/mcp` door (phases 5–7, 10) | the above and `models`, `tools` |
| `workspaces/` | workspaces, their keys' mutations, server entries, and what each request may reach | all of the above |
| `graphql/` | schema assembly, permissions, operation limits, the Yoga handler | everything |
| `http/` | `createApp`, the OIDC redirects, static files, shutdown, health | everything |
| `admin/` | the built-in admin server, the only way to the router's management tools | everything |

`index.ts` at the root of `server/` is boot only. The last column is kept by reading for now; a
lint rule is planned.

## Commands

```bash
npm run dev          # server (watch) + Vite
npm run check        # codegen, biome, tsc
npm run db:up        # a local Postgres for development, on 127.0.0.1:5440
npm test             # vitest on PGlite, in memory
npm run db:generate  # a migration after a schema change; commit it
npm run db:migrate   # apply migrations to DATABASE_URL (boot does this too)
npm run codegen      # print the schema, then the UI's types
docker compose up
```

## Things that are easy to get wrong

Each one has an invariant in the domain model and deserves a test. The backend skill's
non-negotiables apply on top of these.

### Callers and keys

- **The key decides the scope, never the URL.** A request carries one key, and a key belongs to
  one workspace. A user's session, as the UI uses it, sees every agent. There are no
  `/w/<slug>` routes.
- **Every key is a workspace key; people never use keys.** Keys come from `Authorization: Bearer`
  or `x-api-key`, and if both are sent and differ, the request is refused. A Bearer value is
  tried as a key first, then as a user's session token. Keys are managed only from a session, by
  any user.
- **Sign-in is whoever the OIDC provider allows.** Don't add an allow list here; heautou's groups
  decide.
- **Admin-only:** secrets, settings, roles and override policies. The first user to sign in becomes admin, and the
  last admin can be neither demoted nor deleted. Everything else is open to every user.
- **Settings are one router-wide row.** `settings.values` holds only what an admin set, parsed by
  `savedSettingsSchema` and spread over `ROUTER_DEFAULTS` (`core/settings.ts`), so an unset one
  follows its default. Every user reads `routerSettings`; only an admin calls
  `updateRouterSettings`, and no run or key reaches either. Today it holds the app-tool cap,
  `unlistedFields` and `pruneAppToolsAcrossServers`.
- **`SECURE_LOCAL_NET` only signs people in.** Whoever opens the UI becomes the admin without
  OIDC. A request to `/v1` or `/runs` without a workspace key is still refused.
- **None of the router's stored secrets leave it.** Secret columns are in `exclude.columns`, and
  each is set by its own write-only mutation. Reads answer `apiKeySet: boolean`. A test plants
  each secret and scans every answer.

### Endpoints and names

- **`/v1` lists and runs only agents.** No endpoint serves a raw model or tool. `/mcp` offers
  the same agents as MCP tools, one per agent the key's workspace may run: a `message` in, the
  answer out, progress as MCP progress notifications. Each call is an ordinary run (stateless,
  no app tools, so it never waits); a `conversation` argument works as `X-Conversation-Id`. It is
  stateless, so a client's cancel is matched to its call by key and JSON-RPC id.
- **A model id splits at its first `/`, and a name with no `/` is a pool.** That's how an agent's
  document names its model.
- **Reserved name:** `ai-router` is the admin server's row, which a migration adds with the
  built-in transport and source (`builtin`). No other server takes the name or the transport, and
  nothing deletes or renames the row or gives it env, args, secrets or a login (`tools/builtin`).
  That server is the only way to the management tools, and there is no `/admin/mcp`. Agent ids
  follow the same name rule as providers and servers.
- **Two transports reach a server at an address:** `streamable-http` and `sse`, the older
  HTTP+SSE one. Both take headers, a login and a workspace entry's URL, so switch on
  `isHttpTransport` (`tools/shapes`), never on one of them.
- **Header values are secrets.** They live in `server_secrets`, set by `setServerSecret` or by
  `installServer`'s `headers`, and both take them only from an admin.
- **Roles live on the admin server's entries only.** A workspace's entry for `ai-router` holds
  roles and nothing else; every other entry's roles stay empty.
- **The admin server lists only what the roles reach, and the schema's permissions are the lock.**
  Its tools come from the same permissioned schema `/graphql` serves, executed with the run's
  `RunCaller`, whose roles are read from the snapshot. A call names its run in `_meta`, set by the
  dispatch and never sent to another server. A run never changes or restarts `ai-router`. The
  listing must fit `MCP_DEFAULTS`; prune it in `admin/server`, never in the schema.
- **No discovery yet.** mcp-router's AI Catalog, cards and LAN announce/discovery are not
  ported in the first pass. When they come, the public catalog names only the endpoint, and
  every agent behind it needs a key.

### Untrusted code and the snapshot

- **MCP child processes are untrusted.** Spawn them with argument arrays and never a shell
  string. Give them an env allowlist plus their own `env`, never `process.env`. Start every one
  through `run-as-child <uid> [-g <gid>] [-G <gids>] -- <command…>` (`childCommand`), and the
  installer's `npm install` and `uvx` too, since install scripts are code. A workspace instance
  is its entry's uid with the server's gid. Never give the router or node a capability, and
  never swap the helper for a general tool like `setpriv`: with `CAP_SETUID`, that can become
  root. Group rules (no system group, child id or router group as an extra group) live in the
  helper itself; node only repeats them for a friendly error. The helper's source is
  `docker/run-as-child.c`, and its checks are `scripts/check-children.sh`, which CI runs against
  the image.
- **Requests route from the snapshot.** Keys, agents, providers, servers and the router's
  settings are read from it, never from the database per request. Every
  mutation that changes routing rebuilds the snapshot after its transaction commits. One process
  owns a database: a Postgres advisory lock taken at boot, so a second
  router refuses to start.

### Agents

- **A workspace decides an agent's servers.** The workspace decides which agents an app may run,
  and, per agent, which MCP servers its runs there reach: exactly those granted
  (`workspace_agent_servers`, set by the people-only `setWorkspaceAgentServers`), and none
  without a grant. The agent's document decides its models; ai-router ignores its
  `tools.servers` (a save warns) until the spec drops it. No admin-server role reaches the grants,
  so a run never widens its own reach. The admin server is reached only when granted, and its
  tools still only as far as the workspace's roles. The calling workspace's server entry decides
  how each server is configured, so its workspace instance is used; without an entry, the base
  instance. An entry configures a server and never grants one.
- **A layer adds and never widens.** The layers are the router's, the agent's and the request's.
  Everything above the agent passes the override policy before `resolveAgentSpec`. `endpoint`
  and the model never change for a request, and a caller's `servers` is intersected with the
  workspace's grant. Sampling settings pass only if the policy allows them, and never reach side tasks.
- **Nothing is trimmed quietly.** A field the router doesn't read and the policy doesn't list
  refuses the request, unless the `unlistedFields` setting is `ignore`: then it is dropped and
  named in `X-AI-Router-Ignored`, set before the first byte, as is any `stream_options` key but
  `include_usage` (named `stream_options.<key>`). Only those are ever ignored: messages, tools,
  `n`, `response_format`, `agent_core` (a part `parseAppParts` would drop included), `ai_router`
  (its old name) and a bad value of a listed field still refuse.
- **The router layer goes underneath every run.** It sets the endpoint to the router's internal
  model address, which the run's `fetch` hands to the models area in process, so an agent
  without an endpoint, and its side tasks, can run, and usage counts under the run.
- **Map sampling fields by name.** `temperature` goes to `model.temperature`, and `max_tokens` or
  `max_completion_tokens` to `model.maxTokens`. Only fields the format can't spell go into
  `extraBody`. Never copy a request's fields into `extraBody` wholesale
  ([agent-core#222](https://github.com/cubicecho/agent-core/issues/222)).
- **The app's parts are stacked by agent-core's `stackAppParts`, never by rules of our own.**
  They are `agent_core.prompt`, then the request's leading `system`/`developer` messages as
  `app_system`. Every app name gets `app_`, and agent-core refuses an agent's part whose first
  word is `app`, so an app never overwrites or deletes an agent's part; it extends or replaces
  one only where the part's `allowedModes` lets it. A part that breaks that is dropped, never
  refused: a notice, and `agent_core.warnings` on the answer (beside `choices`, or on the
  stream's finish chunk). There is no switch for system messages or app parts, and no task
  field. A resume that sends different system messages or parts is refused.
- **The override policy is a row, not part of the document.** Every agent points at one through
  `agents.override_policy_id`: the seeded default until a user chooses another. Read it from the
  snapshot, and never hard-code its rules. It says nothing about the prompt: that is the agent's
  parts' `allowedModes`. Policies widen what apps may do, so only an admin
  writes one, as with settings; any user chooses among them. The default and any policy in use
  are never deleted.
- **A run's servers are an exact list.** `resolveRun` puts the workspace's grant in place of the
  document's `tools.servers`, so there is no "every server": no grant means none, and an emptied
  list means none, never all.
- **An app tool that duplicates the agent's own is pruned, never refused.** Older apps send their
  own MCP servers' tools. The same name as one of the agent's tools is always dropped. The same
  tool under another server's name (equal after the first `__`, deep-equal input schemas) is
  dropped only under `pruneAppToolsAcrossServers`, off by default, each drop logged with `[runs]`.
  `X-AI-Router-Pruned-Tools` names them, set before the first byte. A pruned tool is never handed
  back, and `runs.resume.appTools` keeps the tools as sent, so each resume prunes them again.
- **A waiting run resumes only when every handed-back call is answered.** It is matched by the
  call ids the router minted. Refuse a partial answer.
- **Revisions are append-only, but for drafts, and only a user promotes.** A user's saves go live,
  and a run's saves are drafts unless the agent auto-promotes. Only a draft is ever deleted
  (`discardRevision`), and a run deletes only its own agent's drafts for its workspace. Auto-promote
  is a column on `agents`, set only by a user, never a field in the document, so no draft can
  switch it on. A run keeps the revision it started with.
- **Run records are append-only.** Once a run ends, only retention deletes it or its events.
- **A cancel ends only a run that is going.** `POST /runs/<id>/cancel` (the run's own workspace
  key; any other run is 404) and the people-only `cancelRun` abort a running run's loop, model and
  tool calls, or stop a waiting one waiting. It ends `cancelled` with the reason and one last
  `done`. An ended run is answered unchanged, never rewritten. No admin-server role reaches
  `cancelRun`.
- **Slim apps keep `runAgentLoop`.** The `/v1/models` entry marks each agent with
  `agent_core: { kind: "agent", prompt }`, its parts' names and `allowedModes` as the document
  states them (no text), and an app copies the kind into its config as the agent flag
  ([agent-core#223](https://github.com/cubicecho/agent-core/issues/223)). Don't add an
  ai-router-specific client. The entry also carries `context_length` when it is known (the
  document's `model.contextLength`, else the provider's listing), and never `0`.
- **A client that asks for no progress sees the work as reasoning.** A stream without
  `agent_core.progress` carries the run's thinking, and a line per tool call and result, as
  `delta.reasoning_content`, which chat clients fold away. One that asks gets the events instead,
  never both.
- **Stored documents and runs were upgraded once, at boot** (`agents/upgrade.ts`, after the
  migrations): version 1 revisions through `upgradeSpec`, the policies' old prompt switches
  taken out (naming each agent whose policy refused system messages), and waiting runs' layers
  renamed. Each step finds only what is still old.
- **A repeated `Idempotency-Key` returns the run it already started.** A retry must never start a
  second run.
- **Run events are `agent-core`'s `RunEvent`, unchanged,** as JSON: agent-core has no encoder for them. The router
  numbers them itself and never restarts `seq`, across a wait or a restart. That's what `min-agent`,
  `task_server` and telos already render, so progress chunks, `run_events` rows and
  `/runs/<id>/events` all carry it as it is. A progress chunk has empty `choices`, like OpenAI's
  usage chunk, so standard clients skip it. A key reads only its own workspace's runs.
- **Followers get every delta; the table gets them folded.** `run-bus` stores each stretch of
  `thinking` or `output` as one row with agent-core's `fold`, under its last event's `seq`, so
  stored `seq`s increase with gaps. A stretch still going stays in memory until it ends (or
  `RUN_DEFAULTS.streamHoldMs`), and `text_ends` lets a reader that had part of a stretch, live,
  get only the rest. Never number stored rows yourself, and never assume `seq + 1` is stored.
- **A run session is a label, never routing.** `runs.session_key` is the conversation's key, else
  `X-Session-Id` (agent-core sends its loop's `session` there), read before the run starts and
  refused like `X-Conversation-Id` when malformed. It groups runs per workspace across agents, and
  nothing reads it to decide how a run goes. `runSessions` reads every workspace, so it is
  people-only.
- **A run keeps its input, not as an event.** `runs.input` holds what each request added: the new
  run's system, developer and user messages (for a conversation, only the new ones), then each
  resume's tool answers. Apps already show their own input, so it isn't a progress event.
- **Store the document as received.** `agent_revisions.document` is the `jsonb` that `parseSpec`
  accepted. Don't split it into columns, and don't rewrite unknown keys.
- **The spec is agent-core's.** Parse, resolve and export with its functions. Never restate
  `AgentSpec` or its merge rules here, and fix a gap upstream.
- **Absent inherits, and nothing else does.** `0`, `""` and `[]` are values. Add no sentinels.
- **An agent with an explicit `endpoint.baseUrl` gets no key.** Keys go only to their own
  provider.

### Error formats

- GraphQL: `extensions.code` from `ErrorCode`.
- `/v1`, auth refusals included: OpenAI's `{ error: { message, type, code } }`.
- `/runs`: `{ error, code }`.

Don't leak one surface's format into another.

## Git

- Conventional Commits; semantic-release derives versions and image tags from them on `main`.
- No `Co-Authored-By` trailers or other AI attribution.
- `npm run check && npm test` before every commit. A schema change also commits its migration.
- A commit that changes a concept, an actor's writes, a state or an invariant updates
  `.agents/domain-model.md` in the same commit.
