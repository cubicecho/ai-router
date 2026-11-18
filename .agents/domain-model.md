# Domain model

What ai-router is made of: its concepts, who may change them, and what always holds. Use these
terms, and only these, in code, tests, docs and reviews.

**Phases 1 to 3 are built:** sign-in, roles, workspaces, keys, the snapshot, the models area
(providers, pools, forwarding, usage) and the tools area (registries, servers, secrets, server
entries, install folders, shared groups, instances and their user ids, server login, activity)
describe the code as it is. **Phase 5 is built too:** agents, revisions, history and rollback,
warnings, the seeded override policy, and which workspaces may run which agents. Every other entry
is the agreed design, and its `Owner:` is where that concept will live. From
the commit that builds a concept, its entry describes the code, and a proposed change becomes an
`M` item in `.agents/coding-standards-todos.md` before it is written in here.

## Purpose

One self-hosted service that gives every app on a network **agents** to run, through one address
and one key. An agent is a model, a prompt and tools defined once and used by any app. The router
keeps the models and MCP servers its agents use, and serves no raw model or tool to apps: those
that want them use llm-router and mcp-router.

## Flow

```
app ─key→ workspace ─┬─ /v1    agent id → run → resolved agent ─┬→ model id ─→ provider ───────→ model server
                     │                                          │   pool name → pool → target → provider
                     │                                          └→ server → instance → MCP server
                     └─ /runs  a run's record and its events → the app's own timeline

user ─session→ /graphql ─→ every table, through the permission map
```

- **Run an agent:** an app sets its base URL to the **agents endpoint** (`/v1`), whose model list
  holds only agents, and picks one as its model. The router stacks the app's layers on the
  agent's live revision, runs the tool loop, records the run, and streams the answer back. If the
  app asks, the stream also carries each step as a run event, so the app's own chat or Runs tab
  shows the detail it shows today.
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
- **Reach and configuration:** a run's models and servers come from the agent's document
  (`agents/reach`), and each server's configuration from the calling workspace's entry for it
  (`workspaces/`), so `agents` never imports `workspaces`.

## Actors

| Actor | Is | Reaches the system through | May change |
|---|---|---|---|
| User | a person who signs in through OIDC, or is signed in automatically as the admin on a trusted network. Every user sees the same router | a session, in the UI or its calls; never a key | everything except secrets, settings and roles. Creates and revokes workspace keys, and promotes revisions |
| Admin | a user with the admin role. The first user to sign in becomes one | as a user | everything |
| App | a program using the router: `min-agent`, `task_server`, telos, any OpenAI-compatible client | `/v1` and `/runs`, with a workspace key | nothing stored but its own conversations. It may run the agents its workspace grants, and send layers the agent's override policy accepts |
| Run | one agent answering one request | calls the router makes on its behalf | nothing directly. It may call only the tools and models in the agent's reach. Given the admin server, it may write what that server's permission levels allow |
| MCP server | a program the router starts or connects to: untrusted code | stdio or streamable HTTP, from the router's side only | nothing in the router. A child process may read its server's install folder, write its own HOME, read the env it is given, and reach the folders of its server's extra groups |
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
  args, headers or URL, and used by every agent run that workspace starts. So one agent can work
  on each workspace's own account. A stdio one runs as its entry's own user id, with a folder of
  its own made on its first call. Deleting the entry, the workspace or the server stops it and
  removes that folder.

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
| What a request can reach is decided by its credential, never by its URL or by a header the app chooses | `auth/caller`, `workspaces/` |
| A key is read from `Authorization: Bearer` or `x-api-key`. If both are sent and differ, the request is refused | `auth/caller` |
| Keys are created, listed and revoked only from a session, never with a key. Any user may do it | `graphql/permissions` |
| Anyone the paired OIDC provider lets through may sign in. The router keeps no allow list of its own | `auth/` |
| A trusted network changes only how people sign in: they are signed in automatically as the admin. It never lets a request without a key reach `/v1` or `/runs` | `auth/caller` |
| Only an admin sets secrets and settings, and grants or removes the admin role. A server's extra groups count as a setting: a group can open a host folder or socket to the server's code | `graphql/permissions`; `checkServerUpdate` in `tools/hooks` |
| The first user to sign in becomes admin, and the last admin can be neither demoted nor deleted | `auth/admin` |
| None of the router's stored secrets appear in any answer: provider keys, secret server env, server headers, server login tokens or keys. What a tool itself returns is that server's business | `exclude.columns` in `graphql/schema`, write-only mutations, plus a test that plants each secret and scans every answer |
| An MCP child process cannot read the database, its files, the router's environment, or another server's install folder or environment. Each server runs as its own user id from the child range, never root or the router's, with no capabilities and no way to gain any. Its install scripts run as that user too | `tools/instance` and `tools/installer`, through the `run-as-child` helper; checked at boot by preflight |
| Each workspace instance runs as a user id of its own, never handed out twice, with its server's group, so it can read its server's install folder but not write it, and no other instance of that server, base or workspace, can read its environment, HOME or signal it | `workspace_servers.child_uid` from `child_uid_seq`; `tools/resolve`, `tools/install-folder`; `scripts/check-children.sh` |
| A child's groups are exactly its primary group, from the child range, and its server's extra groups. No extra group is a system group (below 100, so never root or shadow), a child id (another server's group), or one the router holds, and a server holds at most 8. The helper itself refuses anything else | `docker/run-as-child.c`; `tools/input` `extraGroupsInput` and `ck_servers_extra_groups` say so first |
| The router itself holds no capabilities. The helper is the only binary with any, holds only `CAP_SETUID` and `CAP_SETGID`, and only the router's group may run it | the Dockerfile |
| Child processes are spawned with argument arrays and an env allowlist, never a shell string or the router's whole `process.env` | `tools/instance` |
| The agents endpoint lists and runs only agents. No endpoint serves a raw model or tool to an app | `agents/routes`, `http/app` |
| A model id splits at its first `/`, and a name with no `/` is a pool | `models/naming` |
| An agent id is unique and follows the same name rule as providers and servers | `agents/document`, and `uq_agents_name` |
| The admin server is the only way to the router's management tools. There is no separate admin endpoint | `admin/server` |
| No server may be named `ai-router`. The name is kept for the admin server | `tools/shapes` `serverNameSchema`, and the check `ck_servers_name_reserved` |
| A server's tokens are only ever sent to the origin they were issued for. Moving its address to another origin drops its login | `tools/oauth/provider`, the server update hook in `tools/hooks` |
| The router never signals or enters a child's folder itself: it has no capability to. It stops a child by closing its stdin, then through the helper as the child's own user, and a child changes into its server's folder after the helper switches users. A folder is made and removed only by the uid that owns it | `tools/instance`, `tools/install-folder` |
| A server's user id, folder, source and login, and a server entry's user id and folder, are kept by the router. No API write sets them | `tools/input` `serverUpdateInput` and `workspaceServerInput`, strict; servers are created and removed only by hand-written mutations |
| A workspace owns nothing. An agent or server may be in any number of workspaces, and leaving one changes nothing else | `db/schema` join tables |
| A workspace decides which agents an app may run, and how their servers are configured for its runs, through its server entries. The agent decides which servers and models it uses, and a server entry never adds a server to a run. Without an entry, a run uses the base instance | `workspaces/`, `agents/reach` |
| An app's layers add to an agent and never widen it. `endpoint` and the model never change for a request. `servers` is intersected with the agent's list. Sampling settings change only as the agent's override policy allows, and never reach its side tasks | `agents/policy` |
| The router builds the host and task layers itself, as prompt parts with the ids `host` and `task`, so an app can never replace or delete one of the agent's own parts. No agent may use those ids, and a save that does is refused | `agents/layers`, `RESERVED_PART_IDS` in `agents/document` |
| The host part comes only from a request's leading `system` or `developer` messages. Later system messages stay in the transcript where they are | `agents/layers` |
| A resumed run keeps the layers it started with. A resume request that sends different host or task text is refused | `agents/run` |
| Every run resolves over the router layer, underneath the agent. An agent with no endpoint of its own, and its side tasks, call the router's own models, in process, and usage counts under the run's workspace and agent | `agents/layers`, `models/forward` |
| An app's `temperature` sets the model's temperature, and `max_tokens` or `max_completion_tokens` its ceiling. Only the sampling fields the agent format has no name for (`top_p`, `top_k`, `min_p`, the penalties, `seed`, `stop`) go into `extraBody`. A sampling field never reaches `extraBody` under a name the format spells elsewhere | `agents/request` |
| A request asking for more than one answer (`n` above 1) is refused. `response_format` is allowed by the default policy, `parallel_tool_calls` passes through, and `user` is recorded on the run | `agents/request` |
| A request repeating an `Idempotency-Key` answers with the run that key already started, never a second run | `agents/run` |
| Every entry on the agents endpoint's model list says it is an agent, so an app's loop knows to run as a thin client | `agents/routes`; `ai_router.kind` |
| Every agent has exactly one override policy. Until policies can be chosen, every agent uses the one seeded default | `db/schema`: `agents.override_policy_id`, defaulting to the seeded row |
| An agent's `tools.servers` keeps three meanings. Absent means every enabled server, `[]` means none, and a list means exactly those. A list that names only unknown servers means none, never all | `agent-core` `resolveAgentSpec`, `agents/reach` |
| The admin server is never in "every server". An agent reaches it only by naming it | `agents/reach` |
| An explicit `endpoint.baseUrl` in an agent is called directly with no key. Keys go only to the providers they were registered for | `agents/reach`, via `agent-core` `NO_KEY` |
| A request resumes a waiting run only if it answers every call that run handed back. A partial answer is refused | `agents/run` |
| A key reads only the runs and run events of its own workspace | `agents/routes` |
| Progress events and `/runs/<id>/events` carry `agent-core` `RunEvent`s unchanged, never a format of the router's own. Progress chunks are written with `agent-core`'s own encoder | `agents/progress` |
| A run's record and events are append-only. Once a run ends, nothing changes them, and only retention deletes them | `agents/run`, `agents/run-bus` |
| Only a user promotes a revision, by hand or by turning on auto-promote for that agent. Workspace keys and runs only make drafts. Auto-promote is a column on the agent, never a field in its document | `agents/revisions`, `graphql/permissions` |
| A stored document keeps every key it was saved with, unknown ones included. The one thing taken out is a bundled server's env and headers, where its credentials live, with a warning | `agents/document`, which stores the `jsonb` as received after agent-core's `exportSpec` |
| An agent and its revisions are written only through `createAgent`, `saveAgent` and `promoteRevision`, which check the document. No generated write reaches them | `graphql/build-schema` (`CREATE_RESERVED`, `UPDATE_RESERVED`, `WRITES_RESERVED`) |
| A bundled MCP server in an agent's document is never started until a user adds it as a server | `agents/reach` |
| Requests route from an in-memory snapshot, rebuilt after every committed write that changes routing. One router process owns a database, and a second refuses to start | `db/snapshot`; a Postgres advisory lock taken at boot |
| Usage is counted from the provider's own numbers, only on a 2xx answer. A run's model calls also count under its agent. A run's tool calls are recorded as activity under its agent and run | `models/usage`, `tools/activity` |

## Glossary

Each definition, up to `Owner:`, is written for someone using the router and holds no code.
Everything about the code comes after `Owner:`.

### The router

- **ai-router:** this service. It gives apps agents through one address. Owner: the repo;
  `server/index.ts`.
- **User:** a person who signs in to the router. Anyone the sign-in provider allows may do so,
  and every user shares the same router. Owner: `auth/`; a better-auth user, signed in through
  OIDC (such as heautou), which decides who may sign in by group.
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
- **Run records:** where an app reads a run it started, and its events, after the answer or
  while it runs. Owner: `agents/routes`; `/runs/<id>` and `/runs/<id>/events`.

### Workspaces

- **Workspace:** what one app may run: chosen agents, and how their servers are configured for
  its runs. Owner: `workspaces/`; the `workspaces` table and its join tables.
- **Server entry:** a server's configuration for the agent runs one workspace starts, such as an
  account's credentials. Owner: `workspace_servers`, with its overrides; its secret overrides are
  `server_secrets` rows that name the workspace. `tools/resolve` merges them over the server's.
- **Workspace key (key):** a secret an app sends with every request, and the only kind of key. It
  belongs to one workspace, is shown once when created, can be given an expiry, and can be
  revoked. Owner: `auth/keys`; a row in `workspace_keys`, which keeps only the key's SHA-256 and
  is checked against the snapshot.

### Models

- **Provider:** a model server the router's agents call, such as OpenAI, Ollama or llama.cpp: its
  address, an optional key and extra headers. Owner: `models/`; the `providers` table, whose
  `api_key` is never served and whose generated `api_key_set` is.
- **Model id:** how an agent names its model: one provider's model, named after the provider, or a
  pool. Owner: `models/naming`; `<provider>/<model>`, split at the first `/`, or a pool's name.
- **Pool:** one model name served by several targets, with the router choosing one for each
  call: the least busy, in turn, or at random. Owner: `models/balancer`; the `pools` table.
- **Target:** one place a pool can send a call: a provider and the model's name there. Owner:
  `models/balancer`; the `pool_targets` table, written whole by `setPoolTargets`.
- **Affinity (sticky):** keeping one conversation's requests on the same target, so its prompt
  cache is reused. Owner: `models/affinity`.
- **Usage:** requests and tokens, counted per day, workspace, provider, model and agent. Usage
  stays after its provider or workspace is deleted. Owner: `models/usage`; the `usage_counts`
  table, which keeps both names, with optional foreign keys to them, written every few seconds.

### Tools

- **Registry:** a catalogue of MCP servers users can browse and install from. Owner:
  `tools/registry`; the `registries` table.
- **Server (MCP server):** one tool provider the router installed or connects to: how to start or
  reach it, its environment and its timeouts. Owner: `tools/`; the `servers` table. Secret env
  values and every header value are in `server_secrets`, written by `setServerSecret` and served
  only by name.
- **Source:** where a server came from: a registry, npm, PyPI, or added by hand by its address.
  Owner: `servers.source`.
- **Transport:** how the router reaches a server: a program it starts, or an address it connects
  to. Owner: `servers.transport`; stdio or streamable HTTP.
- **Tool:** one action a server offers. A run sees each tool named after its server and itself, so
  two servers' tools never clash. Owner: `tools/naming`; `<server>__<tool>`, split at the first
  `__`, so a server's name may hold no `__` and may not end in `_`.
- **Instance:** a running connection to a server: a base instance shared by everyone, or a
  workspace instance when a workspace overrides that server's settings. A server the router starts
  itself runs as a user of its own, walled off from the router and from other servers: the base
  instance as the server's uid and group, a workspace instance as its entry's own uid with the
  server's group, so it can read the server's packages and no other instance can read its
  environment. Both hold the server's shared groups. Owner: `tools/instance`, `tools/resolve`;
  `servers.child_uid` and `workspace_servers.child_uid`, from the range 10000–19999, handed out by
  the sequence `child_uid_seq`, which never cycles, so no id is handed out twice; and the
  `run-as-child` helper.
- **Install folder:** a server's own folder, made by the server's user under the servers folder,
  with a name nobody else can guess: its packages, mode 0750 with the server's own group, so its
  workspace instances may read but not write it, and inside it `home/`, mode 0700, the base
  instance's HOME. A workspace instance has a folder of its own, mode 0700, made by its uid on its
  first call, whose `home/` is its HOME; it still starts in the server's install folder. Owner:
  `tools/install-folder`; `servers.install_dir` and `workspace_servers.install_dir`, under
  `SERVERS_DIR` (default `DATA_DIR/servers`, mode 1733).
- **Shared group:** an extra group a server's instances run with, such as `users` (100), so they
  can reach a folder mounted from the host that belongs to that group. Never a system group, a
  child id or the router's own, and at most 8. Owner: `servers.extra_groups`, checked by
  `tools/input` and refused by `run-as-child` itself.
- **Server login:** the login a remote server asks for, which a user starts once and the router
  keeps for it, refreshing its tokens as they run out. Owner: `tools/oauth`; OAuth, the `oauth`
  column on `servers`, read from the snapshot; the UI sees only `signed_in` and the `login`
  status. The login comes back to `/oauth/callback`, and the router names itself by
  `/oauth/client-metadata.json` to a login that takes that as a client id.
- **Activity:** the record of tool calls made through the router, kept for a while: which tool,
  how long, whether it failed, and the agent and run that made it. Never a call's arguments or
  result. Owner: `tools/activity`; the `activity` table, written every few seconds and pruned after
  30 days. `run_id` has no foreign key, so a call's record outlives its run's.

### Agents

- **Agent:** a model, a prompt and tools defined once, for any app to use. Its name in the router
  is its document's `id`, and can't change. Owner: `agents/`; the `agents` table; its content is
  a `cubicecho.agent/1` document, `@cubicecho/agent-core` `AgentSpec`, kept as JSON.
- **Revision:** one saved version of an agent, numbered from 1, with what the saver said changed.
  Each is a draft, live or retired, and every earlier revision is kept. Owner: `agents/resolvers`
  (`createAgent`, `saveAgent`) and `agents/document` (the check); the `agent_revisions` table.
  Retired is `promoted_at` set and not live.
- **Warnings:** what a save found worth a person's attention, kept on its revision: agent-core's,
  and the router's own (a provider, pool or server the router lacks; reach over every server; an
  agent calling its own address). Never a reason to refuse. Owner: `agents/document`;
  `agent_revisions.warnings`, and `checkAgent` to see them before saving.
- **Draft:** a revision waiting for a user to promote it, made by an app or a run rather than a
  person. Owner: `agents/revisions`.
- **Live revision:** the one revision an agent runs and serves. Owner: `agents.live_revision_id`.
- **Promote:** make a revision live. Any user does it, or auto-promote does it for them. Promoting
  an older one is a rollback. Owner: `agents/resolvers` `promoteRevision`.
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
  `endpoint` to the router's internal model address, which the run's `fetch` hands to
  `models/forward`.
- **Override policy:** what the layers above an agent may change. Anything it does not allow is
  refused. For now there is one policy, which every agent uses: an app may add its own
  instructions, narrow the servers and set sampling settings, but never change the model. Owner:
  `agents/policy` (`DEFAULT_POLICY_RULES`); the `override_policies` table, seeded with one row by
  the migration, and `agents.override_policy_id`, which defaults to it. There is no UI for it, and
  no API writes it.
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
- **Forwarding:** handing one of a run's model calls to a provider: picking a pool's target,
  adding the provider's key and headers, passing the stream through and counting its usage.
  Owner: `models/forward`; a function the run's `fetch` calls, not an HTTP endpoint.
- **Snapshot:** the in-memory copy of everything requests route by, rebuilt after each committed
  write that changes it. Owner: `db/snapshot`.
- **Lease:** an in-flight slot a pool holds for one request, released on every exit path. Owner:
  `models/balancer`.
- **Resolved agent:** the flat settings a run uses, after layers and policy. Owner: `agent-core`
  `ResolvedAgent`.
- **Dispatch:** the function that runs one of a run's tool calls on a tools instance. Owner:
  `agents/run`; `agent-core` `ToolDispatch`.
- **Error formats:**
  - GraphQL answers `extensions.code` from the `ErrorCode` vocabulary.
  - `/v1` answers OpenAI's `{ error: { message, type, code } }`.
  - `/runs` answers `{ error, code }` with the same codes as GraphQL.

  Owner: `core/errors`, `agents/openai-error`.

## Explain test

A **user** signs in and adds **providers**, which are model servers, and groups their models
into **pools**. They install MCP **servers** from a **registry**, and write **agents**, each one a
model, **prompt parts** and a list of servers. Every save is a **revision**. A user's own saves
go **live** at once, and anything an app or a run saves waits as a **draft** until a user
**promotes** it. An **admin** also holds secrets, settings and roles. Each app gets a
**workspace** and a **workspace key**, and the key alone decides which agents the app sees. On the
**agents endpoint**, every model is an agent, and picking one starts a **run**. The router turns
the app's own instructions into a host part and a scheduled job's text into a task part, after
the agent's own parts. The **override policy** lets the app set sampling settings and narrow the
servers, but never change the model, and it refuses anything else. The run loops between the
agent's model and its **reach** of tools until the model answers: a **model id** goes to one
provider, a pool picks a **target** first, and a tool call goes to an **instance** of its server.
A workspace's **server entries** configure those tools for its own runs, such as one household's
budget login. If the model calls an **app tool**, the run waits for the app's answer and then
carries on. Apps never reach the models or tools directly: those are the agents' alone. Every
model call counts as **usage**, every run is recorded, and none of the router's secrets ever
leave it.
