# Domain model

What ai-router is made of: its concepts, who may change them, and what always holds. Use these
terms, and only these, in code, tests, docs and reviews.

**There is no code yet.** Until there is, this file is the agreed design, and each entry's
`Owner:` is where that concept will live. From the first commit that builds a concept, its entry
describes the code as it is, and a proposed change becomes an `M` item in
`.agents/coding-standards-todos.md` before it is written in here.

## Purpose

One self-hosted service that gives every app on a network three things through one address and
one key: **models** to call, **tools** to use, and **agents** to run. An agent is a model, a
prompt and tools defined once and used by any app.

## Flow

```
app ─key→ workspace ─┬─ /v1         agent id ──→ run → resolved agent ─┬→ models (as below)
                     │                                                 └→ tools  (as below)
                     ├─ /bare/v1    model id ──→ provider ─────────────────→ model server
                     │              pool name ─→ pool → target → provider
                     ├─ /bare/mcp   <server>__<tool> → server → instance → MCP server
                     ├─ /agents     agent document → the app runs it itself
                     └─ /runs       a run's record and its events → the app's own timeline

user ─session→ /graphql ─→ every table, through the permission map
```

- **Run an agent:** an app sets its base URL to the **agents endpoint** (`/v1`), whose model list
  holds only agents, and picks one as its model. The router stacks the app's layers on the
  agent's live revision, runs the tool loop, records the run, and streams the answer back. If the
  app asks, the stream also carries each step as a run event, so the app's own chat or Runs tab
  shows the detail it shows today.
- **Call a model:** an app sets its base URL to the **bare models endpoint** (`/bare/v1`) and sends
  a model id or a pool name. The request goes to one provider unchanged.
- **Use tools:** an app's MCP client points at the **bare tools endpoint** (`/bare/mcp`) and sees
  every server its workspace offers as one MCP server, with each tool prefixed by its server's
  name.
- **Fetch an agent (directory mode):** an app that knows the agent format reads the document
  from the **agent directory**, stacks its own layers on top, and runs it with its own
  `agent-core` loop.
- **Manage the router:** users manage it in the UI over `/graphql`. An admin can do everything.
  Other users can do everything except secrets, settings and roles. A later phase adds the admin
  server, which gives agents and MCP clients the same management as tools.

The address is the same for every app. The **key** decides what is behind it. `/mcp` at the root
is kept for agents offered as MCP tools, in a later phase.

Dependencies point one way:
- **General folders** (`core`, `db`, `auth`) know no area.
- **`models` and `tools`** know only the general folders.
- **`agents`** knows `models`, `tools` and the general folders.
- **`workspaces`** knows all of the above.
- **Assembly:** only `graphql/` and `http/` put the areas together.
- **Scope:** `models` and `tools` each declare the scope they need (`ModelScope`, `ToolScope`).
  `workspaces/scope` builds both.
  - **For an app:** from its workspace.
  - **For a run:** the servers come from the agent's document (`agents/reach`), and each one's
    configuration comes from the calling workspace's entry for it.

  So one tools gateway serves both an app and a run, and no import cycle forms.

## Actors

| Actor | Is | Reaches the system through | May change |
|---|---|---|---|
| User | a person who signs in through OIDC, or is signed in automatically as the admin on a trusted network. Every user sees the same router | a session, in the UI or its calls; never a key | everything except secrets, settings and roles. Creates and revokes workspace keys, and promotes revisions |
| Admin | a user with the admin role. The first user to sign in becomes one | as a user | everything |
| App | a program using the router: `min-agent`, `task_server`, telos, Claude Code, any OpenAI or MCP client | `/v1`, `/bare/v1`, `/bare/mcp`, `/agents`, `/runs`, with a workspace key | nothing stored but its own conversations. It may call the agents, models and tools its workspace grants, and send layers the agent's override policy accepts |
| Run | one agent answering one request | calls the router makes on its behalf | nothing directly. It may call only the tools and models in the agent's reach. Given the admin server, it may write what that server's permission levels allow |
| MCP server | a program the router starts or connects to: untrusted code | stdio or streamable HTTP, from the router's side only | nothing in the router. A child process may read its own install folder and the env it is given |
| Router | the router's own background work | timers inside the router | only expired records (runs, run events, activity and conversations past their retention or TTL), folding old usage days into the totals, and the state of server instances. Never config, so a config change by anything other than a user is a bug |

## Lifecycles

### Agent revision

```
saved --> live --next promote--> retired --promote again (rollback)--> live
saved --> draft --promote (a user, or auto-promote)--> live           (phase 9)
          draft --discard (a user)--> gone                            (phase 9)
```

- **Saved:** every save makes a new revision. `parseSpec` checks it on the way in.
- **Hard errors:** a document with one of the spec's four hard errors is refused and never
  saved.
- **Warnings** are kept on the revision and shown.
- **Rollback:** promoting a retired revision makes it live again.
- **Who promotes:**
  - A user's own saves are promoted at once.
  - A save by a workspace key or a run stays a draft until a user promotes it, unless that agent
    has auto-promote turned on.
  - An agent has at most one live revision. An agent with none cannot run.
- **Drafts come with the admin server** (phase 9), the first way anything other than a user can save
  an agent. Revisions, history and rollback come first (phase 5).

### Run

```
received --resolve--> refused (4xx, not recorded)
received --resolve--> running --model answers--> finished
                      running --model calls an app tool--> waiting (finish_reason: tool_calls)
                      waiting --app answers every handed-back call--> running
                      waiting --no answer before the timeout--> expired
                      running --error--> failed
                      running --app disconnects--> cancelled
                      running --cancel (app, later)--> cancelled
```

- **Resolving:** the router applies the override policy to the layers above the agent, then
  calls `resolveAgentSpec`.
- **Refusing:** a layer the policy refuses refuses the whole run, and nothing is quietly
  trimmed. The exception is `servers`, which is narrowed by definition.
- **Revision:** a run keeps the revision it started with. A revision promoted mid-run applies
  to the next run.
- **Waiting:** handing calls back to the app pauses the run. It does not end it.
  - **The same run resumes:** a later request whose newest `tool` messages answer the waiting
    run's calls resumes that run, under the same run id. The router mints those calls' ids, so
    a standard OpenAI client's tool handling is all the app needs.
  - **What is kept:** while it waits, the run keeps its transcript, loaded tools and step.
  - **A partial answer** to the handed-back calls is refused, never guessed at.
- **Recording:** a run is recorded from `running` on, with the revision it ran. It is deleted
  after the retention period.

### Conversation

```
first request with X-Conversation-Id --> open --idle past TTL--> expired (deleted)
open: one run at a time; a second overlapping request gets 409
```

### Server instance

```
stopped --first call--> starting --handshake--> ready --idle past timeout--> stopped
starting --timeout or exit--> failed --backoff--> starting
```

- **Base instance:** a server's shared instance.
- **Workspace instance:** started separately for a workspace that overrides that server's env,
  args, headers or URL. Two kinds of caller use it:
  - that workspace's apps on `/bare/mcp`;
  - every agent run that workspace starts.

  So one agent can work on each workspace's own account.

### Workspace key

```
created (shown once) --> in use --revoke--> deleted
                         in use --expires (if given an expiry)--> expired
```

- **Who manages keys:** any user creates and revokes them, from a session, never with a key.

## Invariants

| Invariant | Will be enforced by |
|---|---|
| Every key is a workspace key. A request carries one key, and the key belongs to one workspace. People never use keys: they use sessions | `auth/caller` |
| What a request can reach is decided by its credential, never by its URL or by a header the app chooses | `auth/caller`, `workspaces/scope` |
| A key is read from `Authorization: Bearer` or `x-api-key`. If both are sent and differ, the request is refused | `auth/caller` |
| Keys are created, listed and revoked only from a session, never with a key. Any user may do it | `graphql/permissions` |
| A trusted network changes only how people sign in: they are signed in automatically as the admin. It never lets a request without a key reach `/v1`, `/bare/v1`, `/bare/mcp`, `/agents` or `/runs` | `auth/caller` |
| Only an admin sets secrets and settings, and grants or removes the admin role | `graphql/permissions` |
| The first user to sign in becomes admin, and the last admin can be neither demoted nor deleted | `auth/admin` |
| None of the router's stored secrets appear in any answer: provider keys, secret server env, server headers, server login tokens or keys. What a tool itself returns is that server's business | `exclude.columns` in `graphql/schema`, write-only mutations, plus a test that plants each secret and scans every answer |
| An MCP child process cannot read the database, its files or the router's environment | `tools/instance` spawns children as a separate user. The mechanism is phase 1's spike |
| Child processes are spawned with argument arrays and an env allowlist, never a shell string or the router's whole `process.env` | `tools/instance` |
| The agents endpoint lists and runs only agents. The bare models endpoint lists and forwards only models and pools. Neither answers for the other's names | `agents/routes`, `models/routes` |
| On the bare models endpoint, a model id splits at its first `/`, and a name with no `/` is a pool | `models/naming` |
| An agent id is unique and follows the same name rule as providers and servers | the agent id check in `agents/revisions` |
| The admin server is the only way to the router's management tools. There is no separate admin endpoint | `admin/server` |
| No server may be named `ai-router`. The name is kept for the admin server | the server name check in `tools/` |
| A workspace owns nothing. A provider, pool, server or agent may be in any number of workspaces, and leaving one changes nothing else | `db/schema` join tables |
| A workspace decides which agents an app may run, and how their servers are configured, through its server entries. The agent decides which servers and models it uses. Granting an agent never grants its reach: an app reaches those servers and models on the bare endpoints only if its workspace lists them as well, and a server entry never adds a server to a run. Without an entry, a run uses the base instance | `workspaces/scope`, `agents/reach` |
| A server entry that is not offered to apps configures agent runs only, and never appears on `/bare/mcp` | `workspaces/scope` |
| An app's layers add to an agent and never widen it. `endpoint` and the model never change for a request. `servers` is intersected with the agent's list. Sampling settings change only as the agent's override policy allows, and never reach its side tasks | `agents/policy` |
| The router builds the host and task layers itself, as prompt parts with the ids `host` and `task`, so an app can never replace or delete one of the agent's own parts. No agent may use those ids, and a save that does is refused | `agents/layers`, the part id check in `agents/revisions` |
| The host part comes only from a request's leading `system` or `developer` messages. Later system messages stay in the transcript where they are | `agents/layers` |
| A resumed run keeps the layers it started with. A resume request that sends different host or task text is refused | `agents/run` |
| Every run resolves over the router layer, underneath the agent. An agent with no endpoint of its own, and its side tasks, call models through the router's bare models endpoint | `agents/layers` |
| An app's `temperature` sets the model's temperature, and `max_tokens` or `max_completion_tokens` its ceiling. Only the sampling fields the agent format has no name for (`top_p`, `top_k`, `min_p`, the penalties, `seed`, `stop`) go into `extraBody`. A sampling field never reaches `extraBody` under a name the format spells elsewhere | `agents/request` |
| Every agent has exactly one override policy. Until policies can be chosen, every agent uses the one seeded default | `db/schema`: `agents.override_policy_id`, defaulting to the seeded row |
| An agent's `tools.servers` keeps three meanings. Absent means every enabled server, `[]` means none, and a list means exactly those. A list that names only unknown servers means none, never all | `agent-core` `resolveAgentSpec`, `agents/reach` |
| The admin server is never in "every server". An agent reaches it only by naming it | `agents/reach` |
| An explicit `endpoint.baseUrl` in an agent is called directly with no key. Keys go only to the providers they were registered for | `agents/reach`, via `agent-core` `NO_KEY` |
| A request resumes a waiting run only if it answers every call that run handed back. A partial answer is refused | `agents/run` |
| A key reads only the runs and run events of its own workspace | `agents/routes`, `workspaces/scope` |
| Progress events and `/runs/<id>/events` carry `agent-core` `RunEvent`s unchanged, never a format of the router's own | `agents/progress` |
| A run's record and events are append-only. Once a run ends, nothing changes them, and only retention deletes them | `agents/run`, `agents/run-bus` |
| Only a user promotes a revision, by hand or by turning on auto-promote for that agent. Workspace keys and runs only make drafts. Auto-promote is a column on the agent, never a field in its document | `agents/revisions`, `graphql/permissions` |
| A stored document keeps every key it was saved with, unknown ones included | `agents/revisions`, which stores the `jsonb` as received |
| A bundled MCP server in an agent's document is never started until a user adds it as a server | `agents/reach` |
| The gateways route from an in-memory snapshot, rebuilt after every committed write that changes routing. One router process owns a database, and a second refuses to start | `db/snapshot`; PGlite's lockfile, or a Postgres advisory lock taken at boot |
| Usage is counted from the provider's own numbers, only on a 2xx answer. A run's model calls also count under its agent | `models/usage` |

## Glossary

Each definition, up to `Owner:`, is written for someone using the router and holds no code.
Everything about the code comes after `Owner:`.

### The router

- **ai-router:** this service. It gives apps models, tools and agents through one address. Owner:
  the repo; `server/index.ts`.
- **User:** a person who signs in to the router. Every user shares the same router. Owner:
  `auth/`; a better-auth user, signed in through OIDC (such as heautou).
- **Admin:** a user who may do everything, including what other users may not: secrets,
  settings, and who else is admin. The first user to sign in becomes one. Owner: `auth/admin`;
  the user's role.
- **Trusted network:** a mode for a router on a private network. Anyone who opens the router's
  page is signed in as the admin, without a login. Apps still need a workspace key. Owner:
  `auth/`; the env var `SECURE_LOCAL_NET`.
- **Settings:** the router's own options that can change while it runs: allowed origins, public
  address, timeouts. Owner: `db/schema` `settings`, a single row. Boot options
  (port, database, secret) are environment variables in `core/config.ts`.

### Endpoints

- **Agents endpoint:** the address apps use to run agents. It looks like any OpenAI-compatible
  model server, except that every model it lists is an agent. Owner: `agents/routes`; `/v1`.
- **Bare endpoints:** the addresses for the plain pieces, without agents: one for models and
  pools, one for MCP servers. An app that runs its own loop uses these. Owner: `models/routes`,
  `tools/routes`; `/bare/v1`, `/bare/mcp` and `/bare/mcp/<server>`.
- **Agent directory:** where an app that knows the agent format fetches its workspace's agents
  to run itself (directory mode). That works only when the workspace also lists the agent's
  servers and models. Owner: `agents/routes`; `/agents`.

### Workspaces

- **Workspace:** what one app may reach: chosen agents, models, pools and servers. Any section may
  be empty. A workspace with only models and servers makes the router a plain model and tool
  server for an app that runs its own loop. Owner: `workspaces/`; the `workspaces` table and its
  join tables.
- **Server entry:** a server listed in a workspace, with optional overrides such as an account's
  credentials. If it is **offered to apps**, the workspace's apps can call it directly. If not, it
  only configures that server for the agent runs this workspace starts. Owner:
  `workspace_servers`, with its overrides and `offered_on_mcp`.
- **Workspace key (key):** a secret an app sends with every request, and the only kind of key. It
  belongs to one workspace, is shown once when created, can be given an expiry, and can be
  revoked. Owner: `auth/keys`; a better-auth API key, with the workspace in its metadata.

### Models

- **Provider:** a model server the router forwards to, such as OpenAI, Ollama or llama.cpp: its
  address, an optional key and extra headers. Owner: `models/`; the `providers` table.
- **Model id:** how an app names a model on the bare models endpoint: one provider's model, named
  after the provider, or a pool. Owner: `models/naming`; `<provider>/<model>`, split at the first
  `/`, or a pool's name.
- **Pool:** one model name served by several targets, with the router choosing one for each
  request. Owner: `models/pool`; the `pools` table.
- **Target:** one place a pool can send a request: a provider and the model's name there. Owner:
  `models/pool`; the `pool_targets` table.
- **Affinity (sticky):** keeping one conversation's requests on the same target, so its prompt
  cache is reused. Owner: `models/affinity`.
- **Usage:** requests and tokens, counted per day, workspace, provider, model and agent. Owner:
  `models/usage`; the `usage` table.

### Tools

- **Registry:** a catalogue of MCP servers users can browse and install from. Owner:
  `tools/registry`; the `registries` table.
- **Server (MCP server):** one tool provider the router installed or connects to: how to start or
  reach it, its environment and its timeouts. Owner: `tools/`; the `servers` table, with secret
  env values in `server_secrets`.
- **Source:** where a server came from: a registry, npm, PyPI, or added by hand by its address.
  Owner: `servers.source`.
- **Transport:** how the router reaches a server: a program it starts, or an address it connects
  to. Owner: `servers.transport`; stdio or streamable HTTP.
- **Tool:** one action a server offers. Apps see each tool named after its server and itself, so
  two servers' tools never clash. Resources and prompts are named the same way. Owner:
  `tools/naming`; `<server>__<tool>` on `/bare/mcp`, unprefixed on `/bare/mcp/<server>`.
- **Instance:** a running connection to a server: a base instance shared by everyone, or a
  workspace instance when a workspace overrides that server's settings. Owner: `tools/instance`.
- **Server login:** the login a remote server asks for, which the router keeps for it. Owner:
  `tools/oauth`; OAuth, the `oauth` column on `servers`.
- **Activity:** the record of tool calls made through the router, kept for a while. Owner:
  `tools/activity`; the `activity` table.

### Agents

- **Agent:** a model, a prompt and tools defined once, for any app to use. Owner: `agents/`; the
  `agents` table; its content is a `cubicecho.agent/1` document, `@cubicecho/agent-core`
  `AgentSpec`.
- **Revision:** one saved version of an agent. Each is a draft, live or retired, and every earlier
  revision is kept. Owner: `agents/revisions`; the `agent_revisions` table.
- **Draft:** a revision waiting for a user to promote it, made by an app or a run rather than a
  person. Owner: `agents/revisions`.
- **Live revision:** the one revision an agent runs and serves. Owner: `agents.live_revision_id`.
- **Promote:** make a revision live. Any user does it, or auto-promote does it for them. Owner:
  `agents/revisions`.
- **Auto-promote:** a user's choice to let one agent's drafts go live without review. Owner:
  `agents.auto_promote`.
- **Prompt part:** one named piece of an agent's instructions. Layers add parts with new names and
  replace parts with the same name. The router adds the app's instructions as a host part and a
  scheduled job's as a task part, after the agent's own. Owner: `agent-core` `PromptPart`; the
  reserved ids `host` and `task`.
- **Side task:** a small job such as titling or summarising a conversation, which an agent may
  run on a different model. Owner: `agent-core` `TaskSpec`.
- **Layer:** one piece stacked for a request. The order is always: the router (underneath
  everything, so an agent without an address of its own runs through the router), then the
  agent, then the host (the app's own instructions), then the task (a scheduled job), then the
  request (the sampling settings the app sent). Owner: `agents/layers`; the router layer sets
  `endpoint` to the router's own `/bare/v1`.
- **Override policy:** what the layers above an agent may change. Anything it does not allow is
  refused. For now there is one policy, which every agent uses: an app may add its own
  instructions, narrow the servers and set sampling settings, but never change the model. Owner:
  `agents/policy`; the `override_policies` table, seeded with one row, and
  `agents.override_policy_id`. There is no UI for it yet.
- **Reach:** the models and servers an agent may use, taken from the agent itself, not from the
  app's workspace. The workspace can still configure those servers for its own runs, but never
  add to them. Owner: `agents/reach`.
- **Run:** one agent answering one request through the router, recorded with the revision it
  ran. The app is told the run's id with every answer. Owner: `agents/run`; the `runs` table, the
  `X-Run-Id` header; wraps `agent-core` `runAgentLoop`.
- **Request options:** what an app that knows the router may add to a request: a task layer's
  text, and whether to send progress events. Owner:
  `agents/request`; the `ai_router` field of the request body.
- **Run events:** a run's steps, reasoning, tool calls and results, side tasks and usage, in
  order. The router's own pages and the app that started the run can follow them live or read
  them afterwards. Owner: `agents/run-bus`; the `run_events` table, the `runEvents`
  subscription and `/runs/<id>/events`; each one is an `agent-core` `RunEvent`.
- **Progress events:** run events streamed to an app that asks for them, inside the answer
  itself. Standard clients skip them. Owner: `agents/progress`; chunks with empty `choices` and an
  `ai_router.event` field.
- **App tool (client tool):** a tool the app sends with its request. The agent may call it. The
  run then hands the call back to the app and waits, and resumes when the app sends the result.
  Owner: `agents/run`; passed to the loop as `hostTools`.
- **Conversation:** optional memory of one chat between requests, named by the app and deleted
  once idle. Owner: `agents/conversation`; the `conversations` table, the `X-Conversation-Id`
  header.

### Administration (a later phase)

- **Admin server:** the router's own management, offered as tools on a built-in server. A
  workspace or an agent is given it like any other server, and that is the only way in. Owner:
  `admin/server`; the reserved name `ai-router`, `@cubicecho/graphql-mcp` over the GraphQL
  schema.
- **Permission level:** what an admin client may do: read, author drafts, operate, install.
  Owner: `graphql/permissions`; set on the admin server and per server entry.

### Internals

- **Caller:** who a request is from: an admin or another user (by session), or an app (by
  workspace key). It is read from the credential once per request. Owner: `auth/caller`;
  `Context.caller`.
- **Scope:** what one request may reach: for the models gateway, which model ids and pools to
  allow and list, and who the usage counts under; for the tools gateway, which servers and which
  overrides. Owner: `models/scope` and `tools/scope` declare it, and `workspaces/scope` builds it,
  with `agents/reach` for a run.
- **Snapshot:** the in-memory copy of everything the gateways route by, rebuilt after each
  committed write that changes it. Owner: `db/snapshot`.
- **Lease:** an in-flight slot a pool holds for one request, released on every exit path. Owner:
  `models/balancer`.
- **MCP session:** one MCP client's streamable-HTTP session with the router. Plain "session"
  always means a user signed in. Owner: `tools/session`.
- **Resolved agent:** the flat settings a run uses, after layers and policy. Owner: `agent-core`
  `ResolvedAgent`.
- **Dispatch:** the function that runs one of a run's tool calls on a tools instance. Owner:
  `agents/run`; `agent-core` `ToolDispatch`.
- **Error formats:**
  - GraphQL answers `extensions.code` from the `ErrorCode` vocabulary.
  - `/v1` and `/bare/v1` answer OpenAI's `{ error: { message, type, code } }`.
  - `/bare/mcp` answers JSON-RPC errors.
  - `/agents` and `/runs` answer `{ error, code }` with the same codes as GraphQL.

  Owner: `core/errors`, `models/openai-error`.

## Explain test

A **user** signs in and adds **providers**, which are model servers, and groups their models
into **pools**. They install MCP **servers** from a **registry**, and write **agents**, each one a
model, **prompt parts** and a list of servers. Every save is a **revision**. A user's own saves
go **live** at once, and anything an app or a run saves waits as a **draft** until a user
**promotes** it. An **admin** also holds secrets, settings and roles. Each app gets a
**workspace** and a **workspace key**, and the key alone decides what the app sees. On the
**agents endpoint**, every model is an agent, and picking one starts a **run**. The router turns
the app's own instructions into a host part and a scheduled job's text into a task part, after
the agent's own parts. The **override policy** lets the app set sampling settings and narrow the
servers, but never change the model, and it refuses anything else. The run loops between the
agent's model and its **reach** of tools until the model answers. A workspace's **server
entries** can configure those tools for its own runs, such as one household's budget login,
without offering them to the app. If the model calls an **app tool**, the run waits for the
app's answer and then carries on. On the **bare endpoints**, an app that runs its own loop gets
the workspace's **model ids**, pools and **tools** directly: a model id goes to one provider, a
pool picks a **target** first, and a tool call goes to an **instance** of its server. An app
that knows the agent format can also fetch an agent from the **agent directory** and run it
itself. Every model call counts as **usage**, every run is recorded, and none of the router's
secrets ever leave it.
