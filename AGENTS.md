# AGENTS.md — ai-router

ai-router gives every app on a network **agents**, **models** and **tools** through one address
and one key per app.

- **`/v1` is the agents endpoint.** It looks like any OpenAI-compatible server, but every model
  it lists is an agent: a `cubicecho.agent/1` document naming a model, a prompt and tools.
- **`/bare/v1` forwards to model servers**, and **`/bare/mcp` serves MCP servers** over
  streamable HTTP. They are for apps that run their own loop.
- **The key decides what each app sees.** It belongs to a **workspace**, which lists the agents,
  models and servers that app may use.

It replaces llm-router and mcp-router (`../llm-router`, `../mcp/mcp-router`). They are the
reference implementations to port from, not dependencies.

**Status: planning. No code yet.**

- **Concepts, actors, lifecycles and invariants:** [`.agents/domain-model.md`](.agents/domain-model.md).
  Use its terms everywhere.
- **Decisions and the order of work:** [`PLAN.md`](PLAN.md).
- **The agent format:** `../agent-core/docs/agent-spec.md`, implemented in
  `@cubicecho/agent-core` (`src/spec/`).
- **How a cubicecho backend is built:** the `cubicecho_backend` skill (single-operator
  archetype), `cubicecho_typescript` and `coding-standards`. Load all three from the skills server
  before writing code. This file holds only what is specific to ai-router.

## Stack and layout (planned)

Laid out as a single-operator cubicecho service with no tenancy, shared by several users with
roles:
- Node 26, running TypeScript directly.
- graphql-yoga on Express 5.
- Drizzle `1.0.0-rc.5`, with `@vantreeseba/drizzle-graphql` and `@vantreeseba/graphql-casl`.
- better-auth, with `@better-auth/api-key` for workspace keys. Users sign in through OIDC
  (heautou), with no magic links, SMTP or passwords. Under `SECURE_LOCAL_NET`, whoever opens the
  UI is signed in as the admin automatically, and nothing else changes.
- zod and Vitest.
- PGlite by default, or Postgres when `DATABASE_URL` is set.
- Docker on `node:26-slim`.

One package: `server/`, `shared/`, `web/` (Vite, cubeui, GraphQL codegen), `tests/`, `drizzle/`.

| `server/` folder | Holds | May import |
| --- | --- | --- |
| `core/` | config, defaults, wire constants, errors, validation, preflight, context | nothing here |
| `db/` | the client, migrations, waiting for Postgres, the tables, the snapshot | `core` |
| `auth/` | better-auth, keys, the caller, rate limiting | `core`, `db` |
| `models/` | providers, pools, the `/bare/v1` proxy, usage, `ModelScope` | `core`, `db`, `auth` |
| `tools/` | registries, the installer, servers, instances, sessions, the `/bare/mcp` gateway, activity, `ToolScope` | `core`, `db`, `auth` |
| `agents/` | revisions, import and export, layers, override policy, reach, runs, conversations, the `/v1` agents endpoint, `/agents`, `/runs` | the above and `models`, `tools` |
| `workspaces/` | workspaces, server entries, and the scope every request gets | all of the above |
| `graphql/` | schema assembly, permissions, operation limits | everything |
| `http/` | `createApp`, routes, shutdown, health | everything |
| `admin/` (phase 9) | the built-in admin server, the only way to the router's management tools | everything |

A lint rule enforces the last column.

## Commands (planned)

```bash
npm run dev          # server (watch) + Vite
npm run check        # biome + tsc
npm test             # vitest on PGlite
npm run db:generate  # a migration after a schema change; commit it
npm run codegen
docker compose up
```

## Things that are easy to get wrong

Each one has an invariant in the domain model and deserves a test. The backend skill's
non-negotiables apply on top of these.

### Callers and keys

- **The key decides the scope, never the URL.** A request carries one key, and a key belongs to
  one workspace. A user's session, as the UI uses it, sees everything enabled. There are no
  `/w/<slug>` routes. One handler serves every caller, given the scope from `workspaces/scope`.
- **Every key is a workspace key; people never use keys.** Keys come from `Authorization: Bearer`
  or `x-api-key`, and if both are sent and differ, the request is refused. A Bearer value is
  tried as a key first, then as a user's session token. Keys are managed only from a session, by
  any user.
- **Sign-in is whoever the OIDC provider allows.** Don't add an allow list here; heautou's groups
  decide.
- **A run token is not a key.** It's minted per run, held in memory, accepted only on the
  router's own loopback call to `/bare/v1`, and dead when the run ends. Refuse it everywhere
  else.
- **Admin-only:** secrets, settings and roles. The first user to sign in becomes admin, and the
  last admin can be neither demoted nor deleted. Everything else is open to every user.
- **`SECURE_LOCAL_NET` only signs people in.** Whoever opens the UI becomes the admin without
  OIDC. A request to `/v1`, `/bare/v1`, `/bare/mcp`, `/agents` or `/runs` without a workspace key
  is still refused.
- **None of the router's stored secrets leave it.** Secret columns are in `exclude.columns`, and
  each is set by its own write-only mutation. Reads answer `apiKeySet: boolean`. A test plants
  each secret and scans every answer.

### Endpoints and names

- **`/v1` lists and runs only agents; `/bare/v1` lists and forwards only models and pools.**
  Neither answers for the other's names. `/mcp` stays unanswered until agents are offered as MCP
  tools.
- **On `/bare/v1`, a model id splits at its first `/`, and a name with no `/` is a pool.**
- **Reserved name:** no server may be called `ai-router`, which is kept for the admin server.
  That server is the only way to the management tools, and there is no `/admin/mcp`. Agent ids
  follow the same name rule as providers and servers.
- **No discovery yet.** mcp-router's AI Catalog, Server Cards and LAN announce/discovery are not
  ported in the first pass. When they come, the public catalog names only endpoints, and
  everything behind them needs a key.

### Untrusted code and the snapshot

- **MCP child processes are untrusted.** Spawn them with argument arrays and never a shell
  string. Give them an env allowlist plus their own `env`, never `process.env`. Run them as the
  child user, who cannot read `DATA_DIR/pg` or the router's environment.
- **The gateways route from the snapshot.** They never query the database per request. Every
  mutation that changes routing rebuilds the snapshot after its transaction commits. One process
  owns a database: PGlite's lockfile, or a Postgres advisory lock taken at boot, so a second
  router refuses to start.

### Agents

- **An agent runs with its own reach.** The workspace decides which agents an app may run, and
  the agent's document decides its models and servers. Don't intersect an agent's servers with
  the workspace's. The calling workspace's server entry decides how each of those servers is
  configured, so its workspace instance is used. Without an entry, the base instance is used.
  An entry never adds a server. The admin server is never part of "every server".
- **Granting an agent grants the run, not its reach.** A workspace that lists only
  `personal-finance` shows it on `/v1`, and none of that agent's models on `/bare/v1` or its
  servers on `/bare/mcp`. Those appear only if the workspace lists them too.
- **`offered_on_mcp: false`** means a server entry configures agent runs only. It must never show
  on `/bare/mcp` or `/bare/mcp/<server>`.
- **A layer adds and never widens.** The order is agent, host, task, request. Everything above
  the agent passes the override policy before `resolveAgentSpec`. `endpoint` and the model never
  change for a request, and a caller's `servers` is intersected with the agent's. Sampling
  settings pass only if the policy allows them, and never reach side tasks.
- **The router layer goes underneath every run.** It sets the endpoint to the router's own
  `/bare/v1`, so an agent without one, and its side tasks, can run.
- **Map sampling fields by name.** `temperature` goes to `model.temperature`, and `max_tokens` or
  `max_completion_tokens` to `model.maxTokens`. Only fields the format can't spell go into
  `extraBody`. Never copy a request's fields into `extraBody` wholesale
  ([agent-core#222](https://github.com/cubicecho/agent-core/issues/222)).
- **The router builds the host and task parts, never the app.** The host part is the request's
  leading `system`/`developer` messages, and the task part is `ai_router.task`. They use the
  reserved ids `host` and `task`, which no agent may use, so an app can't replace or delete an
  agent's part. A resume that sends different host or task text is refused.
- **The override policy is a row, not part of the document.** Every agent points at one through
  `agents.override_policy_id`. Until policies can be chosen, that's always the seeded default.
  Read it from the table, and never hard-code its rules.
- **`tools.servers` has three meanings.** Absent means every server, `[]` means none, and a list
  means exactly those. An emptied list means none, never all.
- **A waiting run resumes only when every handed-back call is answered.** It is matched by the
  call ids the router minted. Refuse a partial answer.
- **Revisions are append-only, and only a user promotes.** A user's saves go live, and an app's
  or a run's saves are drafts. Auto-promote is a column on `agents`, never a field in the
  document, so no draft can switch it on. A run keeps the revision it started with.
- **Run records are append-only.** Once a run ends, only retention deletes it or its events.
- **Slim apps keep `runAgentLoop`.** The `/v1/models` entry marks each agent with
  `ai_router: { kind: "agent" }`, and an app copies that into its config as the agent flag
  ([agent-core#223](https://github.com/cubicecho/agent-core/issues/223)). Don't add an
  ai-router-specific client.
- **A repeated `Idempotency-Key` returns the run it already started.** A retry must never start a
  second run.
- **Run events are `agent-core`'s `RunEvent`, unchanged,** written with `agent-core`'s encoder. That's what `min-agent`,
  `task_server` and telos already render, so progress chunks, `run_events` rows and
  `/runs/<id>/events` all carry it as it is. A progress chunk has empty `choices`, like OpenAI's
  usage chunk, so standard clients skip it. A key reads only its own workspace's runs.
- **Store the document as received.** `agent_revisions.document` is the `jsonb` that `parseSpec`
  accepted. Don't split it into columns, and don't rewrite unknown keys.
- **The spec is agent-core's.** Parse, resolve and export with its functions. Never restate
  `AgentSpec` or its merge rules here, and fix a gap upstream.
- **Absent inherits, and nothing else does.** `0`, `""` and `[]` are values. Add no sentinels.
- **An agent with an explicit `endpoint.baseUrl` gets no key.** Keys go only to their own
  provider.

### Error formats

- GraphQL: `extensions.code` from `ErrorCode`.
- `/v1` and `/bare/v1`, auth refusals included: OpenAI's `{ error: { message, type, code } }`.
- `/bare/mcp`: JSON-RPC errors.
- `/agents` and `/runs`: `{ error, code }`.

Don't leak one surface's format into another.

## Git

- Conventional Commits; semantic-release derives versions and image tags from them on `main`.
- No `Co-Authored-By` trailers or other AI attribution.
- `npm run check && npm test` before every commit. A schema change also commits its migration.
- A commit that changes a concept, an actor's writes, a state or an invariant updates
  `.agents/domain-model.md` in the same commit.
