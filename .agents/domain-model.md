# Domain model

What ai-router is made of: its concepts, who may change them, and what always holds. Use these
terms, and only these, in code, tests, docs and reviews.

**Phases 1 to 3 are built:** sign-in, roles, workspaces, keys, the snapshot, the models area
(providers, pools, forwarding, usage) and the tools area (registries, servers, secrets, server
entries, install folders, shared groups, instances and their user ids, server login, activity)
describe the code as it is. **Phase 5 is built too:** agents, revisions, history and rollback,
warnings, and which workspaces may run which agents. **So is phase 6:** runs on the
agents endpoint `/v1` (layers, reach, tool names, dispatch, model calls in process, the `runs`
table, `Idempotency-Key`, `X-Run-Id` and the `runEvents` subscription). **So is phase 7:** app tools and waiting
runs, progress events, stored run events and the run records at `/runs`, and conversations. **Of phase 9:** the
roles a run calls the admin server with, drafts, discarding a draft, auto-promote and who saved a revision, though
the admin server itself is not built yet. **Of the workers plan, its data and the router's side:** workers,
worker keys, the `local` worker and a workspace's worker are stored and served, and a workspace's runs go to its
worker: `local`, or a remote worker through the worker doors. Every other entry
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
run ─in process→ admin server ai-router ─→ the same schema, as far as its workspace's roles reach
```

- **Run an agent:** an app sets its base URL to the **agents endpoint** (`/v1`), whose model list
  holds only agents, and picks one as its model. The router stacks the app's layers on the
  agent's live revision, runs the tool loop, records the run, and streams the answer back. If the
  app asks, the stream also carries each step as a run event, so the app's own chat or Runs tab
  shows the detail it shows today.
- **Manage the router:** users manage it in the UI over `/graphql`. An admin can do everything.
  Other users can do everything except secrets, settings and roles. The admin server `ai-router`
  gives an agent run the same management as tools, as far as its workspace's roles reach, when the
  agent names it.

The address is the same for every app. The **key** decides what is behind it. `/mcp` at the root
offers the same agents to MCP clients, one tool per agent.

Dependencies point one way:
- **General folders** (`core`, `db`, `auth`) know no area.
- **`models`, `tools` and `settings`** know only the general folders. The snapshot reads the
  settings through `core/settings`, so no area imports `settings`.
- **`agents`** knows `models`, `tools` and the general folders.
- **`workspaces`** knows all of the above.
- **Assembly:** only `graphql/` and `http/` put the areas together.
- **Reach and configuration:** a run's models come from the agent's document, its servers from
  the calling workspace's servers, less those turned off for that agent (`agents/reach`, read
  from the snapshot), and each server's configuration from the calling workspace's entry for it
  (`workspaces/`), so `agents` never imports `workspaces`.

## Actors

| Actor | Is | Reaches the system through | May change |
|---|---|---|---|
| User | a person who signs in through OIDC, or is signed in automatically as the admin on a trusted network. Every user sees the same router | a session, in the UI or its calls; never a key | everything except secrets, settings and roles. Creates and revokes workspace keys, adds servers to a workspace and turns them off for its agents, and promotes revisions. Makes a workspace as a copy of another (`copyWorkspace`). Makes and deletes workers, rotates their keys, and sets a workspace's worker |
| Admin | a user with the admin role. The first user to sign in becomes one | as a user | everything |
| App | a program using the router: `min-agent`, `task_server`, telos, any OpenAI-compatible client, any MCP client | `/v1`, `/runs` and `/mcp`, with a workspace key | nothing stored but its own conversations' history, through its runs, and cancelling its own workspace's runs. It may run its workspace's agents, set their model's request fields and narrow their servers |
| Worker | a process on another machine that runs a workspace's agent loops, away from the router | the worker doors under `/workers`, with its worker key: its channel, its hello, and the doors of each run executing on it | nothing stored but when it was last seen and the host and version its hello names. For a run the router assigned it, only while it executes there: that run's model calls, the router tools the run's assignment names, its events and its outcome. Its key is refused on every door for apps and people, and on every other worker's runs |
| Run | one agent answering one request | calls the router makes on its behalf | nothing directly. It may call only the agent's models and its workspace's servers that are on for the agent. When it reaches the admin server, it may read and write what its workspace's roles allow, never the admin server itself, and never a workspace's servers or their switches |
| MCP server | a program the router starts or connects to: untrusted code | stdio, streamable HTTP or SSE, from the router's side only | nothing in the router. A child process may read its server's install folder, write its own HOME, read the env it is given, and reach the folders of its server's extra groups |
| Router | the router's own background work | timers inside the router | only expired records (runs, run events, activity and conversations past their retention or TTL), folding old usage days into the totals, the state of server instances, and which pool targets its health checks found down (in memory only). Never config, so a config change by anything other than a user is a bug |

## Lifecycles

### Agent revision

```
saved --> live --next promote--> retired --promote again (rollback)--> live
saved --> draft --promote (a user)--> live
saved --auto-promote on--> live
          draft --discard (a user, or the run's own agent)--> gone
```

- **Saved:** every save makes a new revision. `parseSpec` checks it on the way in.
- **Hard errors:** a document with one of the spec's four hard errors is refused and never
  saved.
- **Warnings** are kept on the revision and shown.
- **Rollback:** promoting a retired revision makes it live again.
- **Who promotes:**
  - A user's own saves are promoted at once.
  - A save by anything but a user (in practice an agent run, through the admin server) stays a draft
    until a user promotes it, unless that agent has auto-promote turned on. Then it goes live as a
    user's save does.
  - A new agent's first revision goes live whoever saves it: there is nothing live yet to protect.
  - An agent has at most one live revision. An agent with none cannot run.
- **Who saved it:** a user's save records the user (`created_by`). A run's records its workspace
  and agent (`saved_by_workspace_id`, `saved_by_agent_id`) and no user.
- **Based on:** a save may name the revision it started from, one of the same agent's; left out,
  it is the live one. Kept as `based_on_id`, and set null if that revision is discarded.
- **Discard:** deletes a draft, which leaves no trace. A user may discard any draft. A run may
  discard only a draft its own agent saved for its own workspace; any other is refused as
  FORBIDDEN, since the run can read that it exists. A revision that is live or was ever live can't
  be discarded, so the history of what ran is never rewritten. Discarding the newest draft frees its
  number for the next save.
- **Auto-promote** is turned on and off by a user (`setAgentAutoPromote`). Turning it on leaves the
  drafts already saved as drafts.

### Run

```
received --resolve--> refused (4xx, not recorded)
received --its workspace's worker is offline or busy--> refused (503, not recorded)
received --resolve--> running --model answers--> completed
                      running --its remote worker stays away past the grace--> failed
                      running --error, or past the run timeout--> failed
                      running --the router stops or restarts--> failed
                      running --app without a key disconnects--> cancelled  (not a run started as an MCP task)
                      running --cancel (the app's key, or a user)--> cancelled
                      running --model calls an app tool--> waiting (finish_reason: tool_calls)
                      waiting --app answers every handed-back call--> running
                      waiting --app answers, while the worker it ran on is offline or busy--> waiting (503)
                      waiting --no answer before the wait timeout--> expired
                      waiting --cancel (the app's key, or a user)--> cancelled
                      waiting --the router stops or restarts--> waiting
                      waiting --the router stops or restarts, parked on a server's question--> failed
                      waiting --a server's question is answered, or lapses and is declined--> running
```

- **Resolving:** the router stacks the request's layer (its model settings and narrowed servers)
  on the agent's, then calls `resolveAgentSpec`.
- **Refusing:** a request the router can't read refuses the whole run, and nothing is trimmed
  quietly. `servers` is narrowed by definition. Every request field the router doesn't read goes
  to the agent's model, unless the agent locks it. A **locked field**, and a key of
  `stream_options` but `include_usage`, refuse, unless the router's **unlisted fields** setting is
  `ignore`: then they are dropped and the answer names them in `X-AI-Router-Ignored` (a stream
  option as `stream_options.<key>`).
- **Revision:** a run keeps the revision it started with. A revision promoted mid-run applies
  to the next run.
- **Waiting:** handing calls back to the app pauses the run. It does not end it.
  A server's question pauses it the same way, but its loop and tool call stay open in memory (parked), so only
  this process can carry it on.
  - **Handing back:** the agent's own calls in the same step run first, and the app's calls go
    back as an ordinary OpenAI answer with `finish_reason: "tool_calls"`, streamed or not.
  - **The same run resumes:** a later request whose trailing `tool` messages answer the waiting
    run's calls resumes that run, under the same run id. The router mints those calls' ids, so
    a standard OpenAI client's tool handling is all the app needs. The match is by those ids,
    within the key's workspace and the agent the request names.
  - **What is kept:** while it waits, the run keeps its transcript, loaded tools, layers and the
    app's tools on its row, so it can be resumed after a restart too. A resume rebuilds
    agent-core's state from them and carries on.
  - **What a resume keeps:** the revision, layers, app parts and system messages the run started
    with. A resume may repeat the system messages and app parts or leave them out, and different
    ones are refused. Its other layers are ignored.
  - **A partial answer** to the handed-back calls is refused, never guessed at, and so is one
    that answers anything else. A late answer to an expired run gets 409 `run_expired`.
  - **The run timeout** counts the time a run runs, from its start or a resume; waiting doesn't
    count. Waiting past `RUN_DEFAULTS.waitTimeoutHours` expires it.
- **Cancelling:** an app cancels a run of its own workspace with `POST /runs/<id>/cancel`, and a
  user cancels any run with `cancelRun` or the run page's Cancel. A running run stops its loop and
  the model and tool calls it is making; a waiting one stops waiting. Either ends `cancelled`, with
  the reason the canceller gave (or one naming them) as its error and a last `done` event, and an
  open stream or a repeated key gets 409 `run_cancelled`. Cancelling a run that has ended answers
  with it unchanged. A late answer to a cancelled run's calls gets 409 `run_cancelled` too.
- **Recording:** a run is recorded from `running` on, with the revision it ran, what its requests added, and the end it came
  to: its answer and token counts, or why it failed or was cancelled. It is deleted after the
  retention period. A run the router was running when it stopped is marked failed at the next boot.
- **Repeating:** a request with an `Idempotency-Key` its workspace already used never starts a
  run. The same body (less `stream` and `stream_options`) gets that run's answer again, streamed or
  not as this request asks, after waiting for it if it is still going. A different body is
  refused with 422. Once the idempotency window has passed, the key is cleared from the run and
  may start a new one. A run answers to the key of its latest request: a resume takes over the
  key it sends, or clears it, so a retry of the resume gets the resume's answer.

### Conversation

```
first request with X-Conversation-Id --> open --idle past CONVERSATION_DEFAULTS.idleHours--> expired --prune--> deleted
open: one run at a time; a request that overlaps a running or waiting run gets 409
expired, not yet pruned --next request--> open again, with no history
```

- **Whose:** a conversation belongs to the key's workspace, under the app's own id, and to the
  agent it started with. Another agent can't join it.
- **History:** the router keeps the transcript of the conversation's last completed run, its
  tool calls and results included, and the app's system messages it ran with. A request then
  sends only what is new: user messages, and system messages to change the instructions. A
  request that sends none keeps the stored system messages. App parts are not kept: a request
  sends its own. A failed, cancelled or expired run adds nothing, so a retry of
  the same message isn't in the history twice.
- **Mixing:** once a conversation has history, a request that sends assistant or tool messages
  with it is refused, since resent history and new turns can't be told apart. The one exception is
  the `tool` messages that answer a waiting run of the conversation, which resume it. The first
  request of a conversation may send any history, which starts it.
- **Runs:** each run names the conversation it belongs to, and a conversation lists its runs.
  When a conversation is deleted, its runs stay, naming none.

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
- **The admin server's instances:** one per workspace whose runs call it, entry or not, granting
  that workspace's roles, and a base instance granting every role, which only lists the tools for
  a person. Each is served inside the router, connected in process, and never stops when idle. A
  change to a workspace's roles replaces its instance.

### Workspace key

```
created (shown once) --> in use --revoke--> deleted
                         in use --expires (if given an expiry)--> expired
```

- **Who manages keys:** any user creates and revokes them, from a session, never with a key.

### Worker

```
local: added by a migration, keyless --> always there
created with its key (shown once) --> in use --rotate (the new key shown once)--> in use, the old key refused
                                      in use --delete, while no workspace names it--> gone, its runs naming none
in use: offline --opens its channel--> online --its channel closes, or a newer one replaces it--> offline
```

- **Who manages workers:** any user makes, rotates and deletes them, from a session, never with a
  key. `local` has no key to rotate and is never deleted.
- **Online:** a remote worker is online while its channel is open, and takes runs only then; `local` always is.
  Which workers are online, and what each said in its hello, is kept in memory only, beside the snapshot.

## Invariants

| Invariant | Will be enforced by |
|---|---|
| Workspace keys are for apps and worker keys for workers. People never use keys: they use sessions. A request carries one key: a workspace key belongs to one workspace, a worker key to one worker. A worker key is nobody on every door for apps and people (`/v1`, `/mcp`, `/runs`, `/graphql`), and only the worker reader takes one, never a workspace key or a session | `auth/caller` (`readWorkspaceCaller`, `readCaller`, `readWorkerCaller`), `auth/keys` (`air_`, `aiw_`, `findKey`, `findWorkerKey`) |
| What a request can reach is decided by its credential, never by its URL or by a header the app chooses | `auth/caller`, `workspaces/` |
| A key is read from `Authorization: Bearer` or `x-api-key`. If both are sent and differ, the request is refused | `auth/caller` |
| Keys, workspace and worker ones alike, are created, rotated, listed and revoked only from a session, never with a key. Any user may do it | `graphql/permissions` |
| Anyone the paired OIDC provider lets through may sign in. The router keeps no allow list of its own | `auth/` |
| A trusted network changes only how people sign in: they are signed in automatically as the admin. It never lets a request without a key reach `/v1` or `/runs` | `auth/caller` |
| `/v1` reads only workspace keys. A session token sent there is refused, never tried as a person | `auth/caller` `readWorkspaceCaller`, `agents/routes` |
| Only an admin sets secrets and settings, and grants or removes the admin role. A server's extra groups count as a setting: a group can open a host folder or socket to the server's code. Headers a server is added with are secrets too, so `installServer` takes them only from an admin | `graphql/permissions`; `checkServerUpdate` in `tools/hooks`; `installServer` in `tools/resolvers` |
| The first user to sign in becomes admin, and the last admin can be neither demoted nor deleted | `auth/admin` |
| The router's settings are router-wide, one set for every app. Only an admin changes them, each within its range, and a change applies from the next request on. Every user reads them; a workspace key or an agent run reaches neither the read nor the change. A setting nobody set, or a saved value that no longer passes its rules, follows its default | `graphql/permissions` (`updateRouterSettings`: admin; not in `FIELD_GRANTS`), `core/settings`, `settings/resolvers` (rebuilds the snapshot before answering) |
| None of the router's stored secrets appear in any answer: provider keys, secret server env, server headers, server login tokens or keys, and workspace and worker keys, of which only the hash is kept. What a tool itself returns is that server's business | `exclude.columns` in `graphql/schema`, write-only mutations, plus a test that plants each secret and scans every answer |
| A copy of a workspace never carries its keys or secrets: it has the same agents, servers with their env, arguments, address and roles, worker, and servers and tools turned off per agent, so each agent reaches what it does in the original and runs where it does, but no key until one is made and no secret override until one is set. Each of its server entries gets a child user id of its own, so its workspace instances are its own. Only a person copies, since a copy widens what the new workspace's runs reach | `workspaces/resolvers` `copyWorkspace`; `graphql/permissions` (`isUser`; not in `FIELD_GRANTS`) |
| An MCP child process cannot read the database, its files, the router's environment, or another server's install folder or environment. Each server runs as its own user id from the child range, never root or the router's, with no capabilities and no way to gain any. Its install scripts run as that user too | `tools/instance` and `tools/installer`, through the `run-as-child` helper; checked at boot by preflight |
| Each workspace instance runs as a user id of its own, never handed out twice, with its server's group, so it can read its server's install folder but not write it, and no other instance of that server, base or workspace, can read its environment, HOME or signal it | `workspace_servers.child_uid` from `child_uid_seq`; `tools/resolve`, `tools/install-folder`; `scripts/check-children.sh` |
| A child's groups are exactly its primary group, from the child range, and its server's extra groups. No extra group is a system group (below 100, so never root or shadow), a child id (another server's group), or one the router holds, and a server holds at most 8. The helper itself refuses anything else | `docker/run-as-child.c`; `tools/input` `extraGroupsInput` and `ck_servers_extra_groups` say so first |
| The router itself holds no capabilities. The helper is the only binary with any, holds only `CAP_SETUID` and `CAP_SETGID`, and only the router's group may run it | the Dockerfile |
| Child processes are spawned with argument arrays and an env allowlist, never a shell string or the router's whole `process.env` | `tools/instance` |
| The agents endpoint lists and runs only agents. No endpoint serves a raw model or tool to an app. An agent a workspace may not run gets the same 404 as one that doesn't exist, and every other `/v1` path a 404, all in OpenAI's error envelope | `agents/routes`, `http/app` |
| A model id splits at its first `/`, and a name with no `/` is a pool | `models/naming` |
| A pool call is sent again, to the pool's next target, only when its target could not be reached at all, so no provider has done any of it. A timeout or an error answer is passed back. A target that could not be reached is passed over by every pool for `unreachableCooldownSeconds`, and one the health checks found down until a later round finds it up, unless that leaves a pool none | `models/forward`, `models/balancer`, `models/health` |
| A health check asks each provider an enabled pool uses for its model list once a round, whatever the number of targets; a target is down when its provider can't be listed or doesn't list its model | `models/health` |
| A target's weight is its share of its pool's calls under every strategy, and under affinity: weighted rendezvous hashing, so a target leaving moves only its own keys, and bounded load caps each target at its weighted share | `models/balancer` |
| An agent id is unique and follows the same name rule as providers and servers | `agents/document`, and `uq_agents_name` |
| The admin server is the only way to the router's management tools. There is no separate admin endpoint: it is connected in process, through the tools area's instances, like any other server a run reaches | `admin/server` `createAdminServer`, handed to `tools/instances` `serveBuiltin` by `http/app`; no route |
| A run is listed only the admin server's tools whose root field its workspace's roles reach, and none with no entry or no roles. The listing is not the lock: the same permissions `/graphql` has guard every call, so a call past the roles is refused with FORBIDDEN. A tool's result carries no stored secret | `admin/server` (`canReachField`), `graphql/permissions`, `graphql/abilities` |
| A call to the admin server acts as the run that made it, named in the call's `_meta` by the router's own dispatch, never by the model, with the roles of the instance's workspace from the snapshot. A call that names no run, such as a person trying a tool, is refused | `tools/builtin` `runMeta`, `tools/services` `callTool`, `admin/server` `callerOf` |
| An agent run never changes or restarts the admin server, whatever its roles | `tools/hooks` `checkBuiltinUpdate`, `tools/resolvers` `restartServer` |
| Through the admin server, a run lists, tries and restarts only a server's base instance or its own workspace's, never another workspace's, which answers the same 404 as one that doesn't exist | `tools/resolvers` `instanceWorkspace` |
| The admin server's listing fits `MCP_DEFAULTS`: each tool's schema and the whole `tools/list`. Relation filters and orders, a column filter's rarer operators, and the aggregate and group-by tools are left out of it, never out of the schema | `admin/server` (`isOwnColumnFilter`, `UNLISTED_FIELDS`), a test |
| `ai-router` is the admin server, the one server with the built-in transport and source. A migration adds it, and nobody adds another, renames or deletes it, or gives it a transport, env, arguments, secrets or a login. Only whether it is on, its display name and its description change | `tools/shapes` `serverNameSchema` and `installSourceSchema`, the checks `ck_servers_name_reserved` and `ck_servers_builtin_source`; `tools/builtin` `refuseIfBuiltin`, from `tools/hooks`, `tools/services` and `tools/resolvers` |
| `local` is the built-in worker, the router process itself, and the one worker with no key. A migration adds it, and nobody renames or deletes it or gives it a key | `ck_workers_local_keyless`, `ck_workers_key_prefix`; no generated writes on `workers`; `workers/input` `workerInput`, `workers/resolvers` `remoteWorker` |
| A workspace's runs belong on one worker, and none named is `local`: naming `local` stores none, so it has one spelling. Only a person sets it, with `setWorkspaceWorker`; a generated workspace write that names a worker is refused. A worker a workspace names can't be deleted. No admin-server role reaches a worker, its key or a workspace's worker, so a run never moves its own workspace. A copy of a workspace runs on the same worker | `workspaces/resolvers` (`setWorkspaceWorker`, `copyWorkspace`), `workspaces/hooks` `checkWorkspace`, `workers/resolvers` `deleteWorker`, the restricting foreign key `workspaces.worker_id`; `graphql/permissions` (`isUser`; not in `FIELD_GRANTS`) |
| A run door answers only the worker its run is executing on, and only while it executes there, as the router's memory says, never the database. Any other run is a 404 with code `run_not_found`, the same as one that never was. The channel and the hello take only a worker key, refusing anything else with 401 | `workers/routes`, `workers/remote` `running` |
| The worker key is never forwarded. The model door passes on a model call's body, content type and `accept` only, with the run's id as its session; the provider's key is added where the router forwards it. An assignment carries no provider key, server secret or key of any kind | `workers/routes`, `models/forward`; a test scans an assignment |
| A worker calls only the router tools its run's assignment names, through the run's workspace instances, as a run on `local` does; any other is answered as a tool error | `workers/routes` (the tools door) |
| A run goes to the worker its workspace names when it starts, and that worker is recorded on it (null for `local`); a resume carries on on the worker the run ran on. A run whose remote worker is offline, or already running `WORKER_DEFAULTS.maxRunsAtOnce`, is refused with 503 (`worker_offline`, `worker_busy`) before anything is recorded, and a resume is refused the same way and stays waiting | `agents/run` `checkWorker`, `begin`, `resume` |
| A worker's local servers reach only runs placed on it, beside the workspace's servers, named by the same rule. One whose name breaks the router's name rule, or is one of the run's router servers, is left out with a notice, and `agent_core.servers` narrows them too. The per-agent switches don't reach them: the router knows them only by what the worker says | `agents/run` `localTools`, `reachedTools` |
| A run whose remote worker's channel drops gets `reconnectGraceMs` for the worker to dial in again, and then fails, "the worker went away". A worker that comes back is sent nothing again. A cancel is sent down the channel, and a worker that doesn't finish the run within `cancelGraceMs` is no longer waited for | `workers/remote` |
| Roles are held only by a workspace's entry for the admin server: each one from the role vocabulary, none twice. That entry takes no env, arguments, address or secrets, and every other entry's roles stay empty | `tools/input` `rolesInput`, `ck_workspace_servers_roles`; `tools/hooks` `afterEntryWrite` |
| A server's tokens are only ever sent to the origin they were issued for. Moving its address to another origin drops its login | `tools/oauth/provider`, the server update hook in `tools/hooks` |
| The router never signals or enters a child's folder itself: it has no capability to. It stops a child by closing its stdin, then through the helper as the child's own user, and a child changes into its server's folder after the helper switches users. A folder is made and removed only by the uid that owns it | `tools/instance`, `tools/install-folder` |
| A server's user id, folder, source and login, and a server entry's user id and folder, are kept by the router. No API write sets them | `tools/input` `serverUpdateInput` and `workspaceServerInput`, strict; servers are created and removed only by hand-written mutations |
| A workspace owns nothing. An agent or server may be in any number of workspaces, and leaving one changes nothing else | `db/schema` join tables |
| A workspace decides which agents an app may run and which servers they reach: every agent there reaches every server the workspace has, less those turned off for it, and none while the workspace has none. A server added reaches every agent at once, and so does an agent added. The agent decides its models; its document's `tools.servers` is ignored. Only a person adds or removes a workspace's servers or turns one off: no admin-server role reaches `createWorkspaceServer`, `deleteWorkspaceServer` or `setWorkspaceAgentServerEnabled`, so a run never widens its own reach. A workspace server's entry also configures it for the workspace's runs; one that overrides nothing uses the base instance | `workspaces/resolvers` `setWorkspaceAgentServerEnabled`, `graphql/permissions`, `db/snapshot`, `agents/layers` `resolveRun`, `agents/reach` |
| A server taken out of a workspace forgets what was turned off on it there, so added back it reaches every agent again. The move from grants kept every agent's reach exactly: each workspace got every server one of its agents was granted, and each agent had the ones it wasn't granted turned off | `tools/hooks` `forgetSwitches`; migration `20261122185732_workspace_servers` |
| An app's layers add to an agent and never widen it. `endpoint` and the model never change for a request. `servers` (`agent_core.servers`) is intersected with the agent's list. Every request field the router doesn't read goes to the agent's model, and never reaches its side tasks, unless the agent locks it (`model.lockedFields`, held by agent-core's `checkLockedFields`; `max_completion_tokens` counts as `max_tokens`). A locked field, and a `stream_options` key other than `include_usage`, refuse the request, naming each; with the unlisted-fields setting at `ignore` they are dropped instead and named in the answer's `X-AI-Router-Ignored` header (a stream option as `stream_options.<key>`), streamed or not. Ignoring never reaches the messages, the tools, `tool_choice`, `functions`, `n`, `include_usage`, `agent_core` (an app part agent-core's `parseAppParts` can't read included), `ai_router` (its old name, refused with a pointer to the new one), or a bad value of a field the router reads: those refuse whatever the setting | `agents/request` (`holdLockedFields`), `agents/layers` (`resolveAgent`) |
| An app's parts and its system messages are stacked on the agent's by agent-core's `stackAppParts`, never by rules of the router's own. Every app name gets `app_`, and no agent's part name has `app` as its first word (agent-core refuses such a document), so an app never overwrites or deletes an agent's part. It extends or replaces one only where the part's `allowedModes` lets it. A part that breaks that, or is named `system`, is dropped, never refused: a notice event and the answer's `agent_core.warnings` say so. Nothing switches app parts or system messages off | `agents/layers` `resolveRun`, agent-core `stackAppParts` |
| `app_system` comes only from a request's leading `system` or `developer` messages, and is written last in the system prompt, after the loop's server instructions and catalogue. Later system messages stay in the transcript where they are | `agents/request`, agent-core `writeSystemPrompt` |
| A resumed run keeps the revision and layers it started with. A resume request that sends different system messages or app parts is refused | `agents/routes` `resumedLayers`, `runs.resume` |
| Every run resolves over the router layer, underneath the agent. An agent with no endpoint of its own, and its side tasks, call the router's own models, in process, and usage counts under the run's workspace and agent. Only an endpoint at the router's model address gets the run's `fetch`; an agent's own endpoint is called directly | `runner/model-fetch` `withRouterFetch`, `models/forward` `fetchFor`, agent-core `Endpoint.fetch` |
| An app's `temperature` sets the model's temperature, `max_tokens` or `max_completion_tokens` its ceiling, and `reasoning_effort` its reasoning effort. Every other field the router doesn't read (`top_p`, `top_k`, `min_p`, the penalties, `seed`, `stop`, a provider's own) goes into `extraBody`. A field never reaches `extraBody` under a name the format spells elsewhere | `agents/request` |
| A request asking for more than one answer (`n` above 1) is refused. `response_format` and `parallel_tool_calls` pass through to the model, and `user` is recorded on the run | `agents/request` |
| An app's tools are function tools with OpenAI's names, none twice and none named for the loop's own (`load_tools`, `call_tool`, `record_artifact`). A request with more tools than the router's settings allow is refused, before the run is recorded, counting the tools as sent. `tool_choice` may only be `auto`, and the older `functions` are refused | `agents/request` `readAppTools` |
| An app tool that duplicates one of the agent's own is left out, never refused, and the agent's server answers it: always when the names are the same, and, only while the router's setting to prune across servers is on (off by default), when the names differ only before the first `__` and the input schemas are equal, each such one logged. `X-AI-Router-Pruned-Tools` names what was left out, before the answer's first byte, and a notice event says it. A left-out tool is never handed back. A waiting run keeps the app's tools as sent, and each resume leaves them out again by the same rules | `agents/app-tools` `pruneAppTools`, `agents/run` `reachedTools`, `agents/routes`; `pruneAppToolsAcrossServers` |
| Every app tool call is handed back under an id the router minted, in the answer, the events and the stored transcript alike. A repeated identical call is handed back too, never answered from the first | `agents/run` (`freshCallId`, `dedupeToolCalls`) |
| A standard client's answer is the same with progress events as without: they come only when `agent_core.progress` asks, in chunks with empty `choices`, or beside `choices` as `agent_core.events`. A repeated `Idempotency-Key` answers without them, and the app reads them from `/runs/<id>/events` | `agents/completion`, `agents/routes` |
| A stream to a client that didn't ask for progress carries the run's thinking, and a line per tool call and result, as `delta.reasoning_content`, which chat clients fold away above the answer. One that asked gets the events instead, never both | `agents/completion` `reasoningText`, `agents/routes` |
| A request repeating an `Idempotency-Key` answers with the run that key already started, never a second run. Keys are per workspace. A different body under the same key is refused with 422 | `agents/run`, `uq_runs_workspace_id_idempotency_key`, `agents/routes` |
| Every agent answer names its run in `X-Run-Id` once the run exists. A refusal before it does carries none | `agents/routes` |
| `GET /v1/models/<id>` answers with the same entry `GET /v1/models` lists for an agent the key's workspace may run, and with `model_not_found` otherwise: the same 404 for an agent that doesn't exist, has no live revision, or isn't the workspace's to run | `agents/routes` `modelEntry`, `runnableAgent` |
| An app disconnecting cancels its run, unless it sent an `Idempotency-Key` or started the run as an MCP task: that run goes on, so the retry or the task's caller gets its answer. A run past the run timeout fails | `agents/run`, `agents/mcp`; `RUN_DEFAULTS.timeoutMinutes` |
| A cancel ends only a run that is running or waiting, as `cancelled` with one last `done`; an ended run is answered unchanged. A key cancels only its own workspace's runs, and another workspace's run answers the same 404 as one that doesn't exist. `cancelRun` is for people: no admin-server role reaches it | `agents/run` `cancel`, `agents/run-records`; `graphql/permissions` |
| `/mcp` lists exactly the agents `/v1/models` does for the same key, and a tool call is a run of the key's workspace, read like any request. It never hands calls back, so its runs never wait | `agents/mcp`, `agents/start` |
| A run's tool call names the depth an agent it starts would be at (the run's own, plus one; an app's run is 0) in `_meta["cubicecho.com/agent-depth"]`, and the admin server's run marker carries it on to the calls it makes. `/mcp` refuses a call past `RUN_DEFAULTS.maxAgentDepth`, so agents calling each other stop. Only the number leaves the router, never a run's id | `tools/services` `callMeta`, `agents/mcp` `depthOf`, `agents/run` |
| A tool whose listing says it may run as a task, on a server that takes tool calls as tasks, is called as one. The server's call timeout covers starting it and each quiet stretch after, when the router asks how the task stands; the run's own timeout covers the rest. A run cancelled or timed out cancels the task. A task asking for input fails the call | `tools/instance` `callTool` |
| An MCP task is a run: its id is the run's, its status is read from the run's, and a key reaches only its own workspace's tasks, another workspace's answering as missing. Cancelling a task cancels the run, and an ended task can't be cancelled. A waiter on `tasks/result` gets each of the run's events, agent-core's `RunEvent` unchanged, as it happens | `agents/mcp-tasks` `serveTasks`, over the runs table and `agents/run-bus` |
| A run's tools are those of the servers its agent reaches, each named for the model by a rule that is the same every time, and mapped back to its server and tool for that run alone | `agents/tool-names`, `agents/run` |
| A server that fails to start or list its tools is left out of the run, which a notice event says; it never fails the run | `agents/run` |
| An MCP server's question reaches only the caller of the call it belongs to: the task it names, else the only call in flight on that connection. Anything else, a `url` question, or a caller that can't answer is declined | `tools/instance` |
| What a person answers a server is never stored: not in `runs.input`, a transcript or an event. Events hold the question, the action and the answered field names | `agents/run`, `agents/elicit` |
| A run parked on a question is `waiting` with its loop and tool call held in memory, so it is answered once, in the request that resumes it. A restart fails it, and a timeout declines it. The tool is never called twice | `agents/run` |
| Every entry on the agents endpoint's model list says it is an agent, so an app's loop knows to run as a thin client, and names the agent's parts with the `allowedModes` its document states, never their text | `agents/routes`; `agent_core.kind`, `agent_core.prompt`, `agents/layers` `agentPartRules` |
| What the router keeps is in agent-core 7's words: every revision holds a version 2 document, and a waiting run keeps its system messages and app parts. A version 1 document sent to be saved is upgraded first, with a warning; stored ones were upgraded once at boot | `agents/document` `checkDocument`, `agents/upgrade` `upgradeStored`, the `agent_core_7` migration |
| A run's servers are an exact list: the workspace's servers that are on for the agent, as the request narrowed them. A workspace with none, a list naming only unknown servers, or a narrowing to nothing means none, never all | `agents/layers` `withWorkspaceServers`, `agents/reach` |
| The admin server is a workspace server like any other: every agent of a workspace that has it reaches it, unless it is turned off for one, and it lists only what that workspace's roles reach | `agents/reach`, `admin/server` |
| A tool a person turned off for an agent in a workspace is left out of that agent's runs there as each server lists its tools, before the run names them: it takes no name and no slot in the catalogue, a call to it is refused as one the run doesn't have, and an app tool that duplicates it is handed to the app, not pruned. Every other tool of a server that is on is reached, a new one too. A server turned off turns off all its tools and keeps their choices for when it is on again; taking it out of the workspace forgets them. On the admin server it only narrows what the roles reach. Only a person turns a tool off or on: no admin-server role reaches `setWorkspaceAgentToolEnabled` | `workspaces/resolvers` `setWorkspaceAgentToolEnabled`, `graphql/permissions`, `db/snapshot` (`SnapshotAgent.disabledTools`), `agents/run` `reachedTools`, `tools/hooks` `forgetSwitches` |
| An explicit `endpoint.baseUrl` in an agent is called directly with no key. Keys go only to the providers they were registered for | `agents/reach`, via `agent-core` `NO_KEY` |
| A request resumes a waiting run only if its trailing tool messages answer every call that run handed back, and nothing else, within the key's workspace and the agent it names. A partial answer is refused. A waiting run survives a restart | `agents/run` `waitingFor`, `runs.pending_call_ids`, `runs.resume` |
| A key reads only the runs and run events of its own workspace. Another workspace's run answers the same 404 as one that doesn't exist. `runEvents` and `Run.events` are for people; a key is refused | `agents/run-records`; `graphql/permissions` |
| Progress events and `/runs/<id>/events` carry `agent-core` `RunEvent`s unchanged, never a format of the router's own, each with `runId` set to the router's run id. agent-core has no encoder for them, so they are written as JSON, as they are | `agents/completion`, `agents/run-records`, `agents/run-bus` |
| A run's record and events are append-only. Once a run ends, nothing changes them, and only retention deletes them. The one change retention makes short of deleting is clearing a spent `Idempotency-Key` and its hash. The bus numbers a run's events from 1 with no gap and never again, across a restart too, and a follower gets every one. Stored, each stretch of streamed thinking or output is one row under its last event's `seq`, so stored `seq`s only increase, and a reader from inside a stretch gets only the rest of it | `agents/run` (`record` writes only a `running` row, `prune`), `agents/run-bus`, `run_events` keyed by run and `seq`, deleted with the run |
| A conversation has at most one run running or waiting. A request that overlaps one gets 409 `conversation_busy`, unless it answers that waiting run's calls | `agents/run` `begin`, `uq_runs_conversation_id_going` |
| A conversation belongs to one workspace and one agent. Its history is changed only by a completed run of it, and a request with history of its own (assistant or tool messages) is refused once it has some | `agents/conversation` |
| An idle conversation is deleted after `CONVERSATION_DEFAULTS.idleHours`, never while a run of it is running or waiting. Its runs stay | `agents/conversation` `pruneConversations`, `runs.conversation_id` set null |
| A run's session key is the conversation's key, else `X-Session-Id`, set when it starts and never changed. Nothing reads it to decide how a run goes | `agents/session`, `agents/run` `begin` |
| Only a user promotes a revision, by hand or by turning on auto-promote for that agent. Workspace keys and runs only make drafts. Auto-promote is a column on the agent, never a field in its document, and only a user sets it | `agents/revisions` (`savesAsDraft`), `graphql/permissions` (`promoteRevision`, `setAgentAutoPromote`: people only) |
| A draft is a revision never promoted. Every live revision has been promoted, so a draft is never live, and only a draft is ever deleted on its own. A run deletes only the drafts its own agent saved for its own workspace | `agents/revisions` (`isDraft`, `mayDiscard`), `agents/resolvers` `discardRevision` |
| A stored document keeps every key it was saved with, unknown ones included. The one thing taken out is a bundled server's env and headers, where its credentials live, with a warning | `agents/document`, which stores the `jsonb` as received after agent-core's `exportSpec` |
| An agent and its revisions are written only through `createAgent`, `saveAgent`, `promoteRevision`, `discardRevision` and `setAgentAutoPromote`, and the saves check the document. No generated write reaches them | `graphql/build-schema` (`CREATE_RESERVED`, `UPDATE_RESERVED`, `WRITES_RESERVED`) |
| A bundled MCP server in an agent's document is never started until a user adds it as a server | `agents/reach` |
| Requests route from an in-memory snapshot, rebuilt after every committed write that changes routing. One router process owns a database, and a second refuses to start | `db/snapshot`; a Postgres advisory lock taken at boot |
| A pool has both prices or neither; prices are never below 0. A call through a pool with a price costs the pool's price, else its provider's model's | `ck_pools_price`, `models/input`, `web/models/cost` |
| Usage is counted from the provider's own numbers, only on a 2xx answer. A run's model calls also count under its agent. A run's tool calls are recorded as activity under its agent, run and workspace, those it makes through the admin server's `try_server_tool` included, even on a server's base instance. A run never tries the admin server's own tools through `try_server_tool` | `models/usage`, `tools/activity`, `tools/resolvers` (`tryServerTool`) |

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
- **Settings:** the router's own options, which an admin changes on the Settings page while it
  runs, for every app at once. Each has a default and a range; one nobody has set follows its
  default. Today there are three: the most tools an app may send with one request (128 by default,
  OpenAI's own limit); **unlisted fields**, whether a field the agent locks, or a
  `stream_options` key the router doesn't read, is refused (the default) or ignored and named in
  `X-AI-Router-Ignored`;
  and whether an app tool that is one of the agent's under another server's name is left out
  (off by default). Every user may read them. Owner: `db/schema` `settings`, one row or none,
  whose `values` holds only what was set; `core/settings` parses it and spreads it over
  `ROUTER_DEFAULTS`, with the range from `ROUTER_CONFIG_DEFAULTS`; read into the snapshot as
  `Snapshot.settings`; served by `settings/resolvers` (`routerSettings`, `updateRouterSettings`).
  Boot options (port, database, secret) are environment variables in `core/config.ts`.

### Endpoints

- **Agents endpoint:** the address apps use to run agents. It looks like any OpenAI-compatible
  model server, except that every model it lists is an agent. Each agent's entry carries
  `context_length` when it is known: the document's `model.contextLength`, else what its
  provider's model list states for the model (a pool's smallest), read from the cached listing
  with a short bounded wait. Owner: `agents/routes`, `agents/context-length`; `/v1`.
- **Agents MCP door:** the same agents for an MCP client (Claude Desktop, an editor), with the same
  key: one tool per agent its workspace may run, named for the agent. A call takes a `message` and
  an optional `conversation`, which carries history across calls as `X-Conversation-Id` does, and
  answers with the agent's text, the run's id in `_meta.runId`; its steps come as progress
  notifications when the client asks. Each call is a run like any other, recorded under the
  workspace. It sends no app tools, so its runs never wait. A cancelled call or a dropped
  connection cancels the run, unless the call asked to run as a task. Stateless. Owner:
  `agents/mcp`; `/mcp`, with `agents/start` shared with `/v1` for starting a run.
- **Task (MCP):** a call to the agents MCP door that asks to run as a task is answered at once
  with the task, and the run goes on without the connection, to its end, its timeout or a cancel.
  The task is the run: the same id, the same status (running is working, waiting is input
  required, expired is failed), kept as long as the run's record. The caller checks it, waits for
  its result (getting each of the run's events on the way), lists its workspace's tasks or cancels
  one. Owner: `agents/mcp-tasks`; MCP's 2025-11-25 tasks, through the SDK's request schemas and
  handlers of the router's own over the runs table and the run bus. Each event is a progress
  notification linked to the task, with the `RunEvent` in `_meta["cubicecho.com/run-event"]`;
  `RUN_DEFAULTS.taskPollIntervalMs` is the poll interval a task names.
- **Agent call:** an agent's run calling another agent. A workspace adds a router's `/mcp` (this
  one or another) as a streamable-HTTP server, with a workspace key in its headers, and each agent
  behind it is a tool for the agents of that workspace that have it on. The call runs as a task, and the called
  agent's run is a run of its own, under the key's workspace. Its events are filed in the caller's
  run with agent-core's `nestEvent`, `via` naming the run and call each came from, and shown under
  the call, never acted on. A last notice links to its run (`/runs/<id>`), read from the
  answer's `_meta.runId`. Each run is one agent deeper than its caller, and `/mcp` refuses a call
  past `RUN_DEFAULTS.maxAgentDepth`. Owner: `agents/run` (dispatch), `tools/instance`,
  `agents/mcp`.
- **Run records:** where an app reads a run of its own workspace, and its events, after the answer
  or while it runs. Another workspace's run is as missing as one that never was. Owner:
  `agents/run-records`; `GET /runs` (its workspace's runs, newest first, `?session=` for one
  session's, `?limit=` up to `RUN_DEFAULTS.maxRunPageSize`), `/runs/<id>` (agent, revision,
  session, status, input, timings, usage and error),
  `/runs/<id>/events` (JSON, or a live event stream with `Accept: text/event-stream`, which a
  client rejoins with `Last-Event-ID`) and `POST /runs/<id>/cancel` (an optional `{ reason }`,
  answered with the run's record), with workspace keys only and `{ error, code }` refusals.

### Workspaces

- **Workspace:** the entry point to the router, where agents and MCP servers are put together
  for one app: its agents, its servers, which every agent there reaches unless one is turned off
  for it, and how those servers are configured for its runs. An agent is never run but through a
  workspace, so it has no server list of its own. Owner: `workspaces/`; the `workspaces` table and
  its join tables.
- **Workspace server (server entry):** a server in one workspace. Every agent there reaches it,
  unless it is turned off for that agent. Its entry also holds the server's configuration for the
  workspace's runs, such as an account's credentials; one that overrides nothing uses the base
  instance. A workspace's entry for the admin server holds roles instead. Only a person adds or
  removes one. Owner: `workspace_servers`, with its overrides and `roles`; its secret overrides are
  `server_secrets` rows that name the workspace. `tools/resolve` merges them over the server's.
- **Turned-off server:** a workspace server one agent there doesn't reach. Only a person turns one
  off or on again. Removing the agent from the workspace, the server, or the server from the
  workspace forgets it. Owner: `workspaces/resolvers` `setWorkspaceAgentServerEnabled`; the
  `workspace_agent_disabled_servers` table. The snapshot reads the workspace's servers less these
  into `SnapshotAgent.workspaces`.
- **Workspace copy:** a new workspace that starts like an existing one: its agents, its server
  entries without their secrets, what is turned off for each agent there, and its worker. Never
  its keys or secret overrides. Owner: `workspaces/resolvers` `copyWorkspace`.
- **Workspace key (key):** a secret an app sends with every request. It belongs to one workspace,
  is shown once when created, can be given an expiry, and can be revoked. Owner: `auth/keys`
  (`air_`); a row in `workspace_keys`, which keeps only the key's SHA-256 and is checked against
  the snapshot.

### Workers

- **Worker:** where a workspace's agent loops run: `local`, inside the router, or a process on
  another machine that dials in with its worker key and takes runs. It says, when it dials in,
  the machine it runs on, its version and its local servers. A run on a remote worker starts with a
  notice naming it and its machine. Owner: `workers/`; the `workers` table (`last_seen_at`, `host`,
  `version`, written on its hello), `Snapshot.workers`; `workers/registry` (who is online),
  `workers/remote` (the runs on them), `workers/resolvers` (`createWorker`, `rotateWorkerKey`,
  `deleteWorker`, `Worker.online`, `Worker.localServers`); `WORKER_DEFAULTS`.
- **Worker channel:** the one stream a remote worker holds open to the router, which carries what the
  router asks of it: a stretch of a run to execute (an assignment), a run to cancel, and a ping now and then.
  A new channel replaces the old one, which is closed. Owner: `workers/routes` `GET /workers/channel`,
  `workers/registry`; `runner/protocol` `ChannelMessage`.
- **Worker doors (run doors):** the requests a remote worker makes for a run it was assigned: its model calls,
  its calls to the router's tools, its events and its outcome. Each answers only the worker the run is executing
  on. Owner: `workers/routes`, under `WORKERS_PATH`; `runner/protocol` `WorkerDoor`, `runDoorPath`.
- **Worker program:** the process a remote worker is, run with `npm run worker` on its owner's machine. It reads
  the router's address, its worker key, its work root and its local servers' config from the environment, holds
  the channel open (dialling again with a doubling wait), and says hello each time the channel opens and whenever a
  local server's tools change. It runs each assignment's loop with `executeRun`, sends its events in order and then
  its finish, and stops a run on its cancel (finished failed, with the reason) or when a run door answers
  `run_not_found` (sending nothing more). Past `maxRunsAtOnce`, or while stopping, it finishes an assignment at once
  as failed. Owner: `worker/` (`config`, `channel`, `run`, `servers`, `worker`; `index.ts` boots it);
  `WORKER_DEFAULTS`, `WORKER_PROGRAM_DEFAULTS`.
- **Local server:** a server a remote worker runs on its own machine and offers the runs placed on it, beside the
  workspace's servers: the built-in `workdir`, and each server its config names, by a command or an address. It
  runs as the worker's user, on the machine owner's trust, not in the router's sandbox. A command server gets only
  `PATH`, `HOME`, `LANG`, `TERM` and `USER` from the worker's environment, plus its own `env`. One whose name
  breaks the router's name rule, or is `workdir`, and one that fails to start, are left out. Owner:
  `runner/protocol` `WorkerHello.servers`; `worker/servers`, through `tools/child-transport`; `workers/registry`
  `localServers`; a run's tool target with origin `local`.
- **Work root:** the folder on a worker's machine that `workdir` works under (`WORKER_ROOT`, by default
  `~/ai-router-work`). `open_repo` keeps one checkout per repo at `<root>/<host>/<owner>/<name>`, reusing it or
  cloning it, and `workdir` reads nothing outside the root, symlinks included. Owner: `worker/config`,
  `worker/workdir`.
- **Local worker (`local`):** the built-in worker, the router process itself. It has no key, since
  nothing dials in as it, and is never renamed or deleted. Owner: the row the `workers` migration
  adds; `LOCAL_WORKER_NAME`.
- **Worker key:** the secret a remote worker dials in with, shown once when the worker is made or
  its key rotated. It belongs to one worker, never expires, and works nowhere an app's key or a
  person's session does. Owner: `auth/keys` (`aiw_`, `findWorkerKey`), `auth/caller`
  `readWorkerCaller`; `workers.key_hash` (SHA-256 only) and `key_prefix`, served as `keyPrefix`
  and `keySet`; `Snapshot.workerKeys`.
- **A workspace's worker (placement):** the worker a workspace's runs go to, set by a person; none
  set is `local`. A run records the worker it started on and carries on there when it resumes. A
  remote worker that is offline refuses the run as `worker_offline`, and one running as many runs as
  it may as `worker_busy`, both 503. Owner: `workspaces.worker_id`, null for `local`, set by
  `workspaces/resolvers` `setWorkspaceWorker`; `SnapshotWorkspace.workerId`; `runs.worker_id`, null for
  `local` and once its worker is deleted, served as `Run.worker`; `agents/run` `checkWorker`.

### Models

- **Provider:** a model server the router's agents call, such as OpenAI, Ollama or llama.cpp: its
  address, an optional key and extra headers. Owner: `models/`; the `providers` table, whose
  `api_key` is never served and whose generated `api_key_set` is.
- **Model id:** how an agent names its model: one provider's model, named after the provider, or a
  pool. Owner: `models/naming`; `<provider>/<model>`, split at the first `/`, or a pool's name.
- **Pool:** one model name served by several targets, with the router choosing one for each
  call: the least busy, in turn, or at random, each target by its weight. A target that is down
  is passed over, and the call goes to the next. Owner: `models/balancer`; the `pools` table.
- **Target:** one place a pool can send a call: a provider, the model's name there, and a weight,
  its share of the pool's calls (1 unless set). Owner: `models/balancer`; the `pool_targets`
  table, written whole by `setPoolTargets`.
- **Health check:** the router asking, every `POOL_HEALTH_DEFAULTS.intervalSeconds`, each
  provider an enabled pool uses for its model list. A target whose provider doesn't answer, or
  doesn't list its model, is down, and passed over by every pool until a later check finds it
  up. A target is also down for a while after a call could not reach it. The pool page shows
  when each target was last checked and why it is down. Owner: `models/health`; the results are
  held by `models/balancer`, in memory.
- **Affinity (sticky):** keeping one conversation's requests on the same target, so its prompt
  cache is reused. Owner: `models/affinity`.
- **Usage:** requests and tokens, counted per day, workspace, agent, pool, provider and model. A
  call that named a pool counts under the pool as well as the target it went to, so a pool's
  share of a target's calls is told apart from calls naming the target directly. Usage stays
  after its provider, pool, agent or workspace is deleted. Owner: `models/usage`; the
  `usage_counts` table, which keeps their names, with optional foreign keys to them, written
  every few seconds.
- **Price:** what a model costs per million tokens in and out, entered by a user in whatever
  currency they use for every price; nothing is fetched. A provider's model has one, or a pool
  has its own, which wins for calls through the pool. Usage shows its cost at the prices entered
  now, so a price change reprices past usage, and usage with no price shows none. Owner:
  `models/resolvers` `setModelPrice` and the `model_prices` table for a provider's model (gone
  with its provider); the `pools` price columns for a pool; the UI's `models/cost` works the cost
  out.

### Tools

- **Registry:** a catalogue of MCP servers users can browse and install from. Owner:
  `tools/registry`; the `registries` table.
- **Server (MCP server):** one tool provider the router installed or connects to: how to start or
  reach it, its environment and its timeouts. Owner: `tools/`; the `servers` table. Secret env
  values and every header value are in `server_secrets`, written by `setServerSecret`, or by
  `installServer` for the headers a server is added with, in the same transaction as its row, and
  served only by name. Headers go only to a server reached over HTTP.
- **Source:** where a server came from: a registry, npm, PyPI, added by hand by its address, or the
  router itself, for the admin server. Owner: `servers.source`; `builtin` for `ai-router` alone.
- **Transport:** how the router reaches a server: a program it starts, an address it connects to,
  or, for the admin server, inside the router itself. An address is reached over streamable HTTP,
  or over SSE, the older transport that streams events from one address and takes messages posted
  to another. Both take headers and a login, and are never stopped for being idle. A request a
  server refused because it no longer has the session (as after a restart) is sent once more on a
  new one; a request it took and never answered is not, since it may have run. Owner:
  `servers.transport`; `stdio`, `streamable-http`, `sse`, or `builtin` (only `ai-router`'s),
  connected in process. `tools/shapes` `isHttpTransport` is true for the two HTTP ones.
- **Tool:** one action a server offers. A run sees each tool named after its server and itself, so
  two servers' tools never clash. Owner: `tools/naming`; `<server>__<tool>`, split at the first
  `__`, so a server's name may hold no `__` and may not end in `_`.
- **Turned-off tool:** one tool of a workspace's server that a person turned off for one agent
  there, such as a GitHub server's `merge_pull_request` for a triage agent. Its runs in that
  workspace don't see it; every other tool of the server, and any it adds later, stays on. It is
  kept by the tool's own name on its server, so a tool the server renames is on again under its
  new name, and one it stops offering is shown as gone. Owner: `workspace_agent_disabled_tools`,
  set by `workspaces/resolvers` `setWorkspaceAgentToolEnabled`; read into the snapshot as
  `SnapshotAgent.disabledTools` and left out by `agents/run` `reachedTools`.
- **Tool's model name:** the name a run's model calls a tool by. Models accept only letters,
  digits, `_` and `-`, up to 64 characters, so a name that breaks that is changed in a way that is
  the same every time, and the run remembers which tool each name stands for. Owner:
  `agents/tool-names` `runToolNames`. Each character outside `[a-zA-Z0-9_-]` becomes `_`; a name
  over 64 characters, or one two tools come to share, is cut and ends in `_` and the first 8 hex
  characters of the SHA-256 of `<server>__<tool>`. A name that needed no change keeps it. The map
  back to the server and tool lives for one run.
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
  status. A login starts by knocking without a token: an `initialize` posted to a
  streamable-HTTP server, or opening an SSE server's event stream. The login comes back to
  `/oauth/callback`, and the router names itself by
  `/oauth/client-metadata.json` to a login that takes that as a client id.
- **Activity:** the record of tool calls made through the router, kept for a while: which tool,
  how long, whether it failed, and the agent, run and workspace that made it (shown on a server's
  Activity tab, linked to the run). Never a call's arguments or
  result. Owner: `tools/activity`; the `activity` table, written every few seconds and pruned after
  30 days. `run_id` has no foreign key, so a call's record outlives its run's.

### Agents

- **Agent:** a model, a prompt and tools defined once, for any app to use. Its name in the router
  is its document's `id`, and can't change. Owner: `agents/`; the `agents` table; its content is
  a `cubicecho.agent/2` document, `@cubicecho/agent-core` `AgentSpec`, kept as JSON.
- **Locked field:** a request field an agent doesn't let an app change, such as `temperature` or
  `seed`. Every field is open unless the agent locks it, and a person locks one on the agent's
  page, which saves a new revision. A request that sets one is refused, naming it, or it is
  dropped and named when the router's unlisted-fields setting says to ignore. Owner: the
  document's `model.lockedFields` (agent-core 7.2); `agents/request` `holdLockedFields` calls
  agent-core's `checkLockedFields` against the agent resolved alone (`agents/layers`
  `resolveAgent`); the agent page's `web/agents/locked-fields-section.tsx`.
- **Revision:** one saved version of an agent, numbered from 1, with what the saver said changed,
  who saved it and the revision it started from. Each is a draft, live or retired. Every revision
  that has been live is kept; a draft can be discarded. Owner: `agents/resolvers` (`createAgent`,
  `saveAgent`) and `agents/document` (the check); the `agent_revisions` table (`created_by`,
  `saved_by_workspace_id`, `saved_by_agent_id`, `based_on_id`). Retired is `promoted_at` set and
  not live.
- **Warnings:** what a save found worth a person's attention, kept on its revision: agent-core's,
  and the router's own (a provider or pool the router lacks; a `tools.servers` the router
  ignores; an agent calling its own address). Never a reason to refuse. Owner: `agents/document`;
  `agent_revisions.warnings`, and `checkAgent` to see them before saving.
- **Draft:** a revision waiting for a user to promote it, made by an agent run rather than a
  person. Owner: `agents/revisions` (`savesAsDraft`, `isDraft`); `promoted_at` null.
- **Discard:** delete a draft. Any user may, and a run may for the drafts its own agent saved.
  Owner: `agents/resolvers` `discardRevision`, `agents/revisions` `mayDiscard`.
- **Live revision:** the one revision an agent runs and serves. Owner: `agents.live_revision_id`.
- **Promote:** make a revision live. Any user does it, or auto-promote does it for them. Promoting
  an older one is a rollback. Owner: `agents/resolvers` `promoteRevision`.
- **Auto-promote:** a user's choice to let a run's saves of one agent go live without review. It
  promotes nothing already saved. Owner: `agents.auto_promote`, set by `setAgentAutoPromote`.
- **Prompt part:** one named piece of an agent's instructions, such as `identity`, `rules` or
  `format`, written like a chat message: a role, a name and its content. Each part says which
  **modes** an app may use on it: extend (add a part of its own beside it) unless it says
  otherwise, replace (take its place) only if it says so, or none. Owner: `agent-core`
  `PromptPart`, `allowedModes`.
- **App part:** a part an app sends with its request, saying how it uses the agent, such as its
  board lane. It is added after the agent's parts, named with `app_` in front, and may extend or
  replace one of the agent's parts only as that part allows. The app's leading system messages
  become one more, `app_system`, written last. Owner: `agents/request` (the request's
  `agent_core.prompt`, read by agent-core's `parseAppParts`), agent-core `stackAppParts`.
- **Prompt layout:** how an agent's parts are written for its model: `plain` (one after another,
  the default), `markdown` (each under a heading) or `xml` (each in its own tag). The agent's
  document chooses it; an app can't. Owner: `agent-core` `promptLayout`.
- **Warning (about an app part):** an app part the router dropped because the agent's part
  doesn't allow its mode, or because it is named `system`. The run goes on without it. Owner:
  agent-core `StackWarning`; `StartedRun.warnings`, the answer's `agent_core.warnings`.
- **Side task:** a small job such as titling or summarising a conversation, which an agent may
  run on a different model. Owner: `agent-core` `TaskSpec`.
- **Layer:** one piece stacked for a request. The order is always: the router (underneath
  everything, so an agent without an address of its own runs through the router), then the
  agent, then the request (the model settings and narrowed servers the app sent). An app's
  parts are not a layer: they are stacked on the agent's prompt after the layers resolve. Owner: `agents/layers`; the router layer sets
  `endpoint` to the router's internal model address, which the run's `fetch` hands to
  `models/forward`.
- **Reach:** the models and servers a run may use: the models from the agent's document, the
  servers the calling workspace has, less those turned off for that agent, as the request narrowed
  them.
  Owner: `agents/reach`, `agents/layers`.
- **Run:** one agent answering one request through the router, recorded with the revision it
  ran, how it ended (completed, failed, cancelled or expired), its token counts, counted as it
  goes, and its answer. A run that hands app tool calls back waits for the app's answer and
  carries on as the same run. The app is
  told the run's id with every answer. Owner: `agents/run` `createRunService`; the `runs` table
  (the workspace's slug and the agent's name kept beside their ids, which are set to null on
  delete), the `X-Run-Id` header; wraps `agent-core` `runAgentLoop`, in an agent-core runtime of
  its own, which the `local` worker runs in process (`workers/local`, `runner/execute` `executeRun`). The limits are `RUN_DEFAULTS`. GraphQL serves the table read-only, without
  `request_hash` and `resume`.
- **Run input:** what the requests of a run added, in order: the system, developer and user
  messages of the request that started it (its leading system messages and its new turn; for a
  conversation, only what it sent), then the app's answers each resume sent. Kept as text, an
  image as a count. It is not a run event, since the app already shows its own input. Owner:
  `agents/request` (`RunRequest.input`), `agents/run`; `runs.input`, appended to by each resume;
  `Run.input` and `/runs/<id>` `input`; shown first on the run page.
- **Answer:** what a run last said: the text of every turn since its start or resume, a blank
  line between turns, as the stream sent it, why its last turn ended, and the calls it handed
  back if it waits. Kept on the run, so a repeated
  `Idempotency-Key` gets it again. Owner: `runs.answer`; `agents/completion` writes it as a
  `chat.completion` or as `chat.completion.chunk`s.
- **Request options:** what an app that knows agent-core may add to a request: its app parts, a
  narrowing of the agent's servers, and whether to send progress events. Owner:
  `agents/request`; the `agent_core` field of the request body (`prompt`, `servers`,
  `progress`), agent-core's name for it. Any other key is refused, and so is `ai_router`, the
  field's name before agent-core 7.
- **Run events:** a run's exchanges, turns, reasoning, tool calls and results, side tasks and
  usage, in order, numbered from 1 with no gaps. Stored, each stretch of streamed thinking or
  output is folded into one, under the `seq` of its last event. They are agent-core 6's `RunEvent`, which names an
  exchange where 4.x said step; stored ones were renamed by a migration. An answer carries them
  through agent-core's own `progressChunk` and `withProgress`, the encoders its decoder reads. The router's own pages and the app that started the run can
  follow them live or read them afterwards, and a follower gets the stored ones first, then the
  live ones, with no gap and no repeat. Owner: `agents/run-bus`, which numbers each event itself,
  carrying on after the last stored one, holds it in memory until it is written to the
  `run_events` table (every `RUN_DEFAULTS.eventFlushMs`, and whenever the run ends or waits), folded
  by agent-core's `fold`: a stretch still going waits until it ends, or for `streamHoldMs` and is
  stored in parts, and `run_events.text_ends` says where each of a row's events ended, for a reader
  that had part of it live. Rows stored before folding stay one per event. It
  wakes the run's followers, who get every event from memory; the `runEvents` subscription and `Run.events` (`agents/run-resolvers`,
  type `LiveRunEvent`), for people, and `/runs/<id>/events` for apps. Each one is an `agent-core`
  `RunEvent`, stored as it was sent or as `fold` joined it in `run_events.event`, and deleted with its run. The router
  adds a `notice` for each server left out and the closing `done`, which a run a restart cut short
  is given at the next boot.
- **Progress events:** run events sent to an app that asks for them, inside the answer itself:
  each one as it happens in a stream, or all of them beside the answer. Standard clients skip
  them. Owner: `agents/completion` (`ChunkStream.event`, `completionBody`); with
  `agent_core.progress: true`, chunks with empty `choices` and an `agent_core.event` field, or
  `agent_core: { runId, events }` beside `choices`, holding the events of this request's part of
  the run.
- **App tool (client tool):** a tool the app sends with its request. The agent may call it. The
  run then hands the call back to the app and waits, and resumes when the app sends the result.
  Owner: `agents/request` (`tools`), `agents/run`; passed to the loop as `hostTools`, whose
  dispatch answers with a stand-in and agent-core's `end`, so the loop stops after the step. The
  run then stores its transcript in `runs.resume` and the minted ids in `runs.pending_call_ids`.
  One that duplicates one of the agent's own tools is left out instead (`agents/app-tools`), and
  named in the `X-AI-Router-Pruned-Tools` header.
- **Conversation:** optional memory of one chat between requests, named by the app and deleted
  once idle, so the app sends only its new messages. One run at a time. Owner:
  `agents/conversation`; the `conversations` table (per workspace and key, with its agent, the
  app's system messages, transcript and expiry), `runs.conversation_id`, the `X-Conversation-Id` header, and
  `CONVERSATION_DEFAULTS`. GraphQL serves it read-only, with `Conversation.runs` and
  `Run.conversation`; `/runs/<id>` names it as `conversation`.
- **Run session:** the runs one workspace's app said belong together, such as every message of one
  chat or every step of one task, whichever agents ran them. Not a person's sign-in session. The
  app names it: a conversation's key,
  else the `X-Session-Id` header, which agent-core sends with its loop's `session`. A label only:
  it changes nothing about a run, a resume keeps the run's, and a run sent with neither is in
  none. Owner: `agents/session` (`readSessionKey`), `agents/run-sessions`; `runs.session_key`;
  people list sessions with `runSessions`, and an app lists one session's runs with
  `GET /runs?session=`. The runs screen's Sessions tab groups by it. Everything a session says
  about itself is read from its runs, nothing stored: its title is its first user message with
  text, cut to `RUN_DEFAULTS.sessionTitleLength`, and it counts its failed (or expired) and
  cancelled runs, names its latest status and failure, and adds up its runs' time.

### Administration

- **Admin server:** the router's own management, offered as tools on a built-in server, `ai-router`.
  Every agent of a workspace that has it reaches it, unless turned off for one, and its run may use
  what its workspace's entry for it grants. That is the only way in. Owner: `admin/server` `createAdminServer`; `@cubicecho/graphql-mcp`
  over the permissioned GraphQL schema, connected in process with the MCP SDK's in-memory
  transport, its limits in `MCP_DEFAULTS`.
- **Role:** what a workspace lets its agent runs do through the admin server, such as reading agents
  or restarting servers. Roles add up, and none reaches what only people do: promoting, deleting an
  agent, secrets, settings, users, workspaces and keys. Owner: `core/admin-roles` (`AdminRole`), held
  by the workspace's entry for `ai-router` (`workspace_servers.roles`); what each grants is
  `graphql/abilities` `ROLE_GRANTS`.

### Internals

- **Caller:** who a request is from: an admin or another user (by session), an app (by
  workspace key), or an agent run calling the admin server. It is read from the credential once per
  request, and a run's is handed over in process. A remote worker (by worker key) is read only by
  the worker doors, and is no caller anywhere else. Owner: `auth/caller`; `Context.caller`,
  `RunCaller` from `graphql/handler` `createRunContextFactory`, and `WorkerCaller` from
  `readWorkerCaller`, never in `Context`.
- **Forwarding:** handing one of a run's model calls to a provider: picking a pool's target,
  adding the provider's key and headers, passing the stream through and counting its usage.
  Owner: `models/forward`; a function the run's `fetch` calls, not an HTTP endpoint.
- **Snapshot:** the in-memory copy of everything requests route by, rebuilt after each committed
  write that changes it. Owner: `db/snapshot`.
- **Lease:** an in-flight slot a pool holds for one request, released on every exit path. Owner:
  `models/balancer`.
- **Resolved agent:** the flat settings a run uses, after its layers. Owner: `agent-core`
  `ResolvedAgent`.
- **Dispatch:** the function that runs one of a run's tool calls on a tools instance. Owner:
  `agents/run`; `agent-core` `ToolDispatch`, calling `ToolServices.callTool` with the run's
  workspace, so its workspace instance and secrets are used. A tool's error answer reaches the
  model as an error.
- **Error formats:**
  - GraphQL answers `extensions.code` from the `ErrorCode` vocabulary.
  - `/v1` answers OpenAI's `{ error: { message, type, code } }`.
  - `/runs` answers `{ error, code }` with the same codes as GraphQL.

  Owner: `core/errors`, `models/openai-error` (`ModelFailure`, `openAiErrorBody`).

## Explain test

A **user** signs in and adds **providers**, which are model servers, and groups their models
into **pools**. They install MCP **servers** from a **registry**, and write **agents**, each one a
model, **prompt parts** and a list of servers. Every save is a **revision**. A user's own saves
go **live** at once, and anything an app or a run saves waits as a **draft** until a user
**promotes** it. An **admin** also holds secrets, settings and roles. Each app gets a
**workspace** and a **workspace key**, and the key alone decides which agents the app sees. On the
**agents endpoint**, every model is an agent, and picking one starts a **run**. The app's own
**app parts** and system messages come after the agent's parts, and may extend or replace one
only as that part allows. The app may set the model's request fields and narrow the servers, but
never change the model. The run loops between the
agent's model and its **reach** of tools until the model answers: a **model id** goes to one
provider, a pool picks a **target** first, and a tool call goes to an **instance** of its server.
A workspace's **server entries** configure those tools for its own runs, such as one household's
budget login. If the model calls an **app tool**, the run waits for the app's answer and then
carries on. Apps never reach the models or tools directly: those are the agents' alone. Every
model call counts as **usage**, every run is recorded, and none of the router's secrets ever
leave it.
