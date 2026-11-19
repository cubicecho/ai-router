# Domain model

What ai-router is made of: its concepts, who may change them, and what always holds. Use these
terms, and only these, in code, tests, docs and reviews.

**Phases 1 to 3 are built:** sign-in, roles, workspaces, keys, the snapshot, the models area
(providers, pools, forwarding, usage) and the tools area (registries, servers, secrets, server
entries, install folders, shared groups, instances and their user ids, server login, activity)
describe the code as it is. **Phase 5 is built too:** agents, revisions, history and rollback,
warnings, the seeded override policy, and which workspaces may run which agents. **So is phase 6:** runs on the
agents endpoint `/v1` (layers, the override policy, reach, tool names, dispatch, model calls in process, the `runs`
table, `Idempotency-Key`, `X-Run-Id` and the `runEvents` subscription). **So is phase 7:** app tools and waiting
runs, progress events, stored run events and the run records at `/runs`, and conversations. **Of phase 9:** the
roles a run calls the admin server with, drafts, discarding a draft, auto-promote and who saved a revision, though
the admin server itself is not built yet. Every other entry
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
is kept for agents offered as MCP tools, in a later phase.

Dependencies point one way:
- **General folders** (`core`, `db`, `auth`) know no area.
- **`models`, `tools` and `settings`** know only the general folders. The snapshot reads the
  settings through `core/settings`, so no area imports `settings`.
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
| App | a program using the router: `min-agent`, `task_server`, telos, any OpenAI-compatible client | `/v1` and `/runs`, with a workspace key | nothing stored but its own conversations' history, through its runs. It may run the agents its workspace grants, and send layers the agent's override policy accepts |
| Run | one agent answering one request | calls the router makes on its behalf | nothing directly. It may call only the tools and models in the agent's reach. When the agent names the admin server, it may read and write what its workspace's roles allow, and never the admin server itself |
| MCP server | a program the router starts or connects to: untrusted code | stdio, streamable HTTP or SSE, from the router's side only | nothing in the router. A child process may read its server's install folder, write its own HOME, read the env it is given, and reach the folders of its server's extra groups |
| Router | the router's own background work | timers inside the router | only expired records (runs, run events, activity and conversations past their retention or TTL), folding old usage days into the totals, and the state of server instances. Never config, so a config change by anything other than a user is a bug |

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
received --resolve--> running --model answers--> completed
                      running --error, or past the run timeout--> failed
                      running --the router stops or restarts--> failed
                      running --app without a key disconnects--> cancelled
                      running --model calls an app tool--> waiting (finish_reason: tool_calls)
                      waiting --app answers every handed-back call--> running
                      waiting --no answer before the wait timeout--> expired
                      waiting --the router stops or restarts--> waiting
                      running --cancel (app, later)--> cancelled
```

- **Resolving:** the router applies the override policy to the layers above the agent, then
  calls `resolveAgentSpec`.
- **Refusing:** a layer the policy refuses refuses the whole run, and nothing is quietly
  trimmed. The exception is `servers`, which is narrowed by definition.
- **Revision:** a run keeps the revision it started with. A revision promoted mid-run applies
  to the next run.
- **Waiting:** handing calls back to the app pauses the run. It does not end it.
  - **Handing back:** the agent's own calls in the same step run first, and the app's calls go
    back as an ordinary OpenAI answer with `finish_reason: "tool_calls"`, streamed or not.
  - **The same run resumes:** a later request whose trailing `tool` messages answer the waiting
    run's calls resumes that run, under the same run id. The router mints those calls' ids, so
    a standard OpenAI client's tool handling is all the app needs. The match is by those ids,
    within the key's workspace and the agent the request names.
  - **What is kept:** while it waits, the run keeps its transcript, loaded tools, layers and the
    app's tools on its row, so it can be resumed after a restart too. A resume rebuilds
    agent-core's state from them and carries on.
  - **What a resume keeps:** the revision and layers the run started with. A resume may repeat
    the host and task text or leave them out, and different text is refused. Its other layers
    are ignored.
  - **A partial answer** to the handed-back calls is refused, never guessed at, and so is one
    that answers anything else. A late answer to an expired run gets 409 `run_expired`.
  - **The run timeout** counts the time a run runs, from its start or a resume; waiting doesn't
    count. Waiting past `RUN_DEFAULTS.waitTimeoutHours` expires it.
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
  tool calls and results included, and the host text it ran with. A request then sends only what
  is new: user messages, and system messages to change the instructions. A request that sends
  none keeps the stored host text. A failed, cancelled or expired run adds nothing, so a retry of
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

## Invariants

| Invariant | Will be enforced by |
|---|---|
| Every key is a workspace key. A request carries one key, and the key belongs to one workspace. People never use keys: they use sessions | `auth/caller` |
| What a request can reach is decided by its credential, never by its URL or by a header the app chooses | `auth/caller`, `workspaces/` |
| A key is read from `Authorization: Bearer` or `x-api-key`. If both are sent and differ, the request is refused | `auth/caller` |
| Keys are created, listed and revoked only from a session, never with a key. Any user may do it | `graphql/permissions` |
| Anyone the paired OIDC provider lets through may sign in. The router keeps no allow list of its own | `auth/` |
| A trusted network changes only how people sign in: they are signed in automatically as the admin. It never lets a request without a key reach `/v1` or `/runs` | `auth/caller` |
| `/v1` reads only workspace keys. A session token sent there is refused, never tried as a person | `auth/caller` `readWorkspaceCaller`, `agents/routes` |
| Only an admin sets secrets and settings, and grants or removes the admin role. A server's extra groups count as a setting: a group can open a host folder or socket to the server's code. Headers a server is added with are secrets too, so `installServer` takes them only from an admin | `graphql/permissions`; `checkServerUpdate` in `tools/hooks`; `installServer` in `tools/resolvers` |
| The first user to sign in becomes admin, and the last admin can be neither demoted nor deleted | `auth/admin` |
| The router's settings are router-wide, one set for every app. Only an admin changes them, each within its range, and a change applies from the next request on. Every user reads them; a workspace key or an agent run reaches neither the read nor the change. A setting nobody set, or a saved value that no longer passes its rules, follows its default | `graphql/permissions` (`updateRouterSettings`: admin; not in `FIELD_GRANTS`), `core/settings`, `settings/resolvers` (rebuilds the snapshot before answering) |
| None of the router's stored secrets appear in any answer: provider keys, secret server env, server headers, server login tokens or keys. What a tool itself returns is that server's business | `exclude.columns` in `graphql/schema`, write-only mutations, plus a test that plants each secret and scans every answer |
| An MCP child process cannot read the database, its files, the router's environment, or another server's install folder or environment. Each server runs as its own user id from the child range, never root or the router's, with no capabilities and no way to gain any. Its install scripts run as that user too | `tools/instance` and `tools/installer`, through the `run-as-child` helper; checked at boot by preflight |
| Each workspace instance runs as a user id of its own, never handed out twice, with its server's group, so it can read its server's install folder but not write it, and no other instance of that server, base or workspace, can read its environment, HOME or signal it | `workspace_servers.child_uid` from `child_uid_seq`; `tools/resolve`, `tools/install-folder`; `scripts/check-children.sh` |
| A child's groups are exactly its primary group, from the child range, and its server's extra groups. No extra group is a system group (below 100, so never root or shadow), a child id (another server's group), or one the router holds, and a server holds at most 8. The helper itself refuses anything else | `docker/run-as-child.c`; `tools/input` `extraGroupsInput` and `ck_servers_extra_groups` say so first |
| The router itself holds no capabilities. The helper is the only binary with any, holds only `CAP_SETUID` and `CAP_SETGID`, and only the router's group may run it | the Dockerfile |
| Child processes are spawned with argument arrays and an env allowlist, never a shell string or the router's whole `process.env` | `tools/instance` |
| The agents endpoint lists and runs only agents. No endpoint serves a raw model or tool to an app. An agent a workspace may not run gets the same 404 as one that doesn't exist, and every other `/v1` path a 404, all in OpenAI's error envelope | `agents/routes`, `http/app` |
| A model id splits at its first `/`, and a name with no `/` is a pool | `models/naming` |
| A pool call is sent again, to the pool's next target, only when its target could not be reached at all, so no provider has done any of it. A timeout or an error answer is passed back. A target that could not be reached is passed over by every pool for `unreachableCooldownSeconds`, unless that leaves a pool none | `models/forward`, `models/balancer` |
| An agent id is unique and follows the same name rule as providers and servers | `agents/document`, and `uq_agents_name` |
| The admin server is the only way to the router's management tools. There is no separate admin endpoint: it is connected in process, through the tools area's instances, like any other server a run reaches | `admin/server` `createAdminServer`, handed to `tools/instances` `serveBuiltin` by `http/app`; no route |
| A run is listed only the admin server's tools whose root field its workspace's roles reach, and none with no entry or no roles. The listing is not the lock: the same permissions `/graphql` has guard every call, so a call past the roles is refused with FORBIDDEN. A tool's result carries no stored secret | `admin/server` (`canReachField`), `graphql/permissions`, `graphql/abilities` |
| A call to the admin server acts as the run that made it, named in the call's `_meta` by the router's own dispatch, never by the model, with the roles of the instance's workspace from the snapshot. A call that names no run, such as a person trying a tool, is refused | `tools/builtin` `runMeta`, `tools/services` `callTool`, `admin/server` `callerOf` |
| An agent run never changes or restarts the admin server, whatever its roles | `tools/hooks` `checkBuiltinUpdate`, `tools/resolvers` `restartServer` |
| Through the admin server, a run lists, tries and restarts only a server's base instance or its own workspace's, never another workspace's, which answers the same 404 as one that doesn't exist | `tools/resolvers` `instanceWorkspace` |
| The admin server's listing fits `MCP_DEFAULTS`: each tool's schema and the whole `tools/list`. Relation filters and orders, a column filter's rarer operators, and the aggregate and group-by tools are left out of it, never out of the schema | `admin/server` (`isOwnColumnFilter`, `UNLISTED_FIELDS`), a test |
| `ai-router` is the admin server, the one server with the built-in transport and source. A migration adds it, and nobody adds another, renames or deletes it, or gives it a transport, env, arguments, secrets or a login. Only whether it is on, its display name and its description change | `tools/shapes` `serverNameSchema` and `installSourceSchema`, the checks `ck_servers_name_reserved` and `ck_servers_builtin_source`; `tools/builtin` `refuseIfBuiltin`, from `tools/hooks`, `tools/services` and `tools/resolvers` |
| Roles are held only by a workspace's entry for the admin server: each one from the role vocabulary, none twice. That entry takes no env, arguments, address or secrets, and every other entry's roles stay empty | `tools/input` `rolesInput`, `ck_workspace_servers_roles`; `tools/hooks` `afterEntryWrite` |
| A server's tokens are only ever sent to the origin they were issued for. Moving its address to another origin drops its login | `tools/oauth/provider`, the server update hook in `tools/hooks` |
| The router never signals or enters a child's folder itself: it has no capability to. It stops a child by closing its stdin, then through the helper as the child's own user, and a child changes into its server's folder after the helper switches users. A folder is made and removed only by the uid that owns it | `tools/instance`, `tools/install-folder` |
| A server's user id, folder, source and login, and a server entry's user id and folder, are kept by the router. No API write sets them | `tools/input` `serverUpdateInput` and `workspaceServerInput`, strict; servers are created and removed only by hand-written mutations |
| A workspace owns nothing. An agent or server may be in any number of workspaces, and leaving one changes nothing else | `db/schema` join tables |
| A workspace decides which agents an app may run, and how their servers are configured for its runs, through its server entries. The agent decides which servers and models it uses, and a server entry never adds a server to a run. Without an entry, a run uses the base instance | `workspaces/`, `agents/reach` |
| An app's layers add to an agent and never widen it. `endpoint` and the model never change for a request. `servers` (`ai_router.servers`) is intersected with the agent's list. Sampling settings change only as the agent's override policy allows, and never reach its side tasks. A field the policy doesn't allow refuses the request, naming the field | `agents/request`, `agents/layers`, read from `agents/policy` |
| The router builds the host and task layers itself, as prompt parts with the ids `host` and `task`, so an app can never replace or delete one of the agent's own parts. No agent may use those ids, and a save that does is refused | `agents/layers`, `RESERVED_PART_IDS` in `agents/document` |
| The host part comes only from a request's leading `system` or `developer` messages. Later system messages stay in the transcript where they are | `agents/layers` |
| A resumed run keeps the revision and layers it started with. A resume request that sends different host or task text is refused | `agents/routes` `resumedLayers`, `runs.resume` |
| Every run resolves over the router layer, underneath the agent. An agent with no endpoint of its own, and its side tasks, call the router's own models, in process, and usage counts under the run's workspace and agent. Only an endpoint at the router's model address gets the run's `fetch`; an agent's own endpoint is called directly | `agents/layers` `withRouterFetch`, `models/forward` `fetchFor`, agent-core `Endpoint.fetch` |
| An app's `temperature` sets the model's temperature, and `max_tokens` or `max_completion_tokens` its ceiling. Only the sampling fields the agent format has no name for (`top_p`, `top_k`, `min_p`, the penalties, `seed`, `stop`) go into `extraBody`. A sampling field never reaches `extraBody` under a name the format spells elsewhere | `agents/request` |
| A request asking for more than one answer (`n` above 1) is refused. `response_format` is allowed by the default policy, `parallel_tool_calls` passes through, and `user` is recorded on the run | `agents/request` |
| An app's tools are function tools with OpenAI's names, none twice and none named for the loop's own (`load_tools`, `call_tool`, `record_artifact`). An app tool with the name of one of the agent's own tools is refused, before the run is recorded, naming both. A request with more tools than the router's settings allow is refused, before the run is recorded. `tool_choice` may only be `auto`, and the older `functions` are refused | `agents/request` `readAppTools`, `agents/run` `reachedTools` |
| Every app tool call is handed back under an id the router minted, in the answer, the events and the stored transcript alike. A repeated identical call is handed back too, never answered from the first | `agents/run` (`freshCallId`, `dedupeToolCalls`) |
| A standard client's answer is the same with progress events as without: they come only when `ai_router.progress` asks, in chunks with empty `choices`, or beside `choices` as `ai_router.events`. A repeated `Idempotency-Key` answers without them, and the app reads them from `/runs/<id>/events` | `agents/completion`, `agents/routes` |
| A request repeating an `Idempotency-Key` answers with the run that key already started, never a second run. Keys are per workspace. A different body under the same key is refused with 422 | `agents/run`, `uq_runs_workspace_id_idempotency_key`, `agents/routes` |
| Every agent answer names its run in `X-Run-Id` once the run exists. A refusal before it does carries none | `agents/routes` |
| An app disconnecting cancels its run, unless it sent an `Idempotency-Key`: that run goes on, so the retry gets its answer. A run past the run timeout fails | `agents/run`; `RUN_DEFAULTS.timeoutMinutes` |
| A run's tools are those of the servers its agent reaches, each named for the model by a rule that is the same every time, and mapped back to its server and tool for that run alone | `agents/tool-names`, `agents/run` |
| A server that fails to start or list its tools is left out of the run, which a notice event says; it never fails the run | `agents/run` |
| An MCP server asking for input during a run is declined: the router's client offers no elicitation, so such a request is answered as one it doesn't support | `tools/instance` (`capabilities: {}`) |
| Every entry on the agents endpoint's model list says it is an agent, so an app's loop knows to run as a thin client | `agents/routes`; `ai_router.kind` |
| Every agent has exactly one override policy. Until policies can be chosen, every agent uses the one seeded default | `db/schema`: `agents.override_policy_id`, defaulting to the seeded row |
| An agent's `tools.servers` keeps three meanings. Absent means every enabled server, `[]` means none, and a list means exactly those. A list that names only unknown servers means none, never all | `agent-core` `resolveAgentSpec`, `agents/reach` |
| The admin server is never in "every server". An agent reaches it only by naming it | `agents/reach` |
| An explicit `endpoint.baseUrl` in an agent is called directly with no key. Keys go only to the providers they were registered for | `agents/reach`, via `agent-core` `NO_KEY` |
| A request resumes a waiting run only if its trailing tool messages answer every call that run handed back, and nothing else, within the key's workspace and the agent it names. A partial answer is refused. A waiting run survives a restart | `agents/run` `waitingFor`, `runs.pending_call_ids`, `runs.resume` |
| A key reads only the runs and run events of its own workspace. Another workspace's run answers the same 404 as one that doesn't exist. `runEvents` and `Run.events` are for people; a key is refused | `agents/run-records`; `graphql/permissions` |
| Progress events and `/runs/<id>/events` carry `agent-core` `RunEvent`s unchanged, never a format of the router's own, each with `runId` set to the router's run id. agent-core has no encoder for them, so they are written as JSON, as they are | `agents/completion`, `agents/run-records`, `agents/run-bus` |
| A run's record and events are append-only. Once a run ends, nothing changes them, and only retention deletes them. The one change retention makes short of deleting is clearing a spent `Idempotency-Key` and its hash. The bus numbers a run's events from 1 with no gap and never again, across a restart too, and a follower gets every one. Stored, each stretch of streamed thinking or output is one row under its last event's `seq`, so stored `seq`s only increase, and a reader from inside a stretch gets only the rest of it | `agents/run` (`record` writes only a `running` row, `prune`), `agents/run-bus`, `run_events` keyed by run and `seq`, deleted with the run |
| A conversation has at most one run running or waiting. A request that overlaps one gets 409 `conversation_busy`, unless it answers that waiting run's calls | `agents/run` `begin`, `uq_runs_conversation_id_going` |
| A conversation belongs to one workspace and one agent. Its history is changed only by a completed run of it, and a request with history of its own (assistant or tool messages) is refused once it has some | `agents/conversation` |
| An idle conversation is deleted after `CONVERSATION_DEFAULTS.idleHours`, never while a run of it is running or waiting. Its runs stay | `agents/conversation` `pruneConversations`, `runs.conversation_id` set null |
| Only a user promotes a revision, by hand or by turning on auto-promote for that agent. Workspace keys and runs only make drafts. Auto-promote is a column on the agent, never a field in its document, and only a user sets it | `agents/revisions` (`savesAsDraft`), `graphql/permissions` (`promoteRevision`, `setAgentAutoPromote`: people only) |
| A draft is a revision never promoted. Every live revision has been promoted, so a draft is never live, and only a draft is ever deleted on its own. A run deletes only the drafts its own agent saved for its own workspace | `agents/revisions` (`isDraft`, `mayDiscard`), `agents/resolvers` `discardRevision` |
| A stored document keeps every key it was saved with, unknown ones included. The one thing taken out is a bundled server's env and headers, where its credentials live, with a warning | `agents/document`, which stores the `jsonb` as received after agent-core's `exportSpec` |
| An agent and its revisions are written only through `createAgent`, `saveAgent`, `promoteRevision`, `discardRevision` and `setAgentAutoPromote`, and the saves check the document. No generated write reaches them | `graphql/build-schema` (`CREATE_RESERVED`, `UPDATE_RESERVED`, `WRITES_RESERVED`) |
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
- **Settings:** the router's own options, which an admin changes on the Settings page while it
  runs, for every app at once. Each has a default and a range; one nobody has set follows its
  default. Today there is one: the most tools an app may send with one request (128 by default,
  OpenAI's own limit). Every user may read them. Owner: `db/schema` `settings`, one row or none,
  whose `values` holds only what was set; `core/settings` parses it and spreads it over
  `ROUTER_DEFAULTS`, with the range from `ROUTER_CONFIG_DEFAULTS`; read into the snapshot as
  `Snapshot.settings`; served by `settings/resolvers` (`routerSettings`, `updateRouterSettings`).
  Boot options (port, database, secret) are environment variables in `core/config.ts`.

### Endpoints

- **Agents endpoint:** the address apps use to run agents. It looks like any OpenAI-compatible
  model server, except that every model it lists is an agent. Owner: `agents/routes`; `/v1`.
- **Run records:** where an app reads a run of its own workspace, and its events, after the answer
  or while it runs. Another workspace's run is as missing as one that never was. Owner:
  `agents/run-records`; `/runs/<id>` (agent, revision, status, input, timings, usage and error) and
  `/runs/<id>/events` (JSON, or a live event stream with `Accept: text/event-stream`, which a
  client rejoins with `Last-Event-ID`), with workspace keys only and `{ error, code }` refusals.

### Workspaces

- **Workspace:** what one app may run: chosen agents, and how their servers are configured for
  its runs. Owner: `workspaces/`; the `workspaces` table and its join tables.
- **Server entry:** a server's configuration for the agent runs one workspace starts, such as an
  account's credentials. A workspace's entry for the admin server holds roles instead. Owner:
  `workspace_servers`, with its overrides and `roles`; its secret overrides are `server_secrets` rows that
  name the workspace. `tools/resolve` merges them over the server's.
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
  call: the least busy, in turn, or at random. A target the router could not reach is passed
  over for a while, and the call goes to the next. Owner: `models/balancer`; the `pools` table.
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
  values and every header value are in `server_secrets`, written by `setServerSecret`, or by
  `installServer` for the headers a server is added with, in the same transaction as its row, and
  served only by name. Headers go only to a server reached over HTTP.
- **Source:** where a server came from: a registry, npm, PyPI, added by hand by its address, or the
  router itself, for the admin server. Owner: `servers.source`; `builtin` for `ai-router` alone.
- **Transport:** how the router reaches a server: a program it starts, an address it connects to,
  or, for the admin server, inside the router itself. An address is reached over streamable HTTP,
  or over SSE, the older transport that streams events from one address and takes messages posted
  to another. Both take headers and a login, and are never stopped for being idle. Owner:
  `servers.transport`; `stdio`, `streamable-http`, `sse`, or `builtin` (only `ai-router`'s),
  connected in process. `tools/shapes` `isHttpTransport` is true for the two HTTP ones.
- **Tool:** one action a server offers. A run sees each tool named after its server and itself, so
  two servers' tools never clash. Owner: `tools/naming`; `<server>__<tool>`, split at the first
  `__`, so a server's name may hold no `__` and may not end in `_`.
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
- **Revision:** one saved version of an agent, numbered from 1, with what the saver said changed,
  who saved it and the revision it started from. Each is a draft, live or retired. Every revision
  that has been live is kept; a draft can be discarded. Owner: `agents/resolvers` (`createAgent`,
  `saveAgent`) and `agents/document` (the check); the `agent_revisions` table (`created_by`,
  `saved_by_workspace_id`, `saved_by_agent_id`, `based_on_id`). Retired is `promoted_at` set and
  not live.
- **Warnings:** what a save found worth a person's attention, kept on its revision: agent-core's,
  and the router's own (a provider, pool or server the router lacks; reach over every server; an
  agent calling its own address). Never a reason to refuse. Owner: `agents/document`;
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
  ran, how it ended (completed, failed, cancelled or expired), its token counts, counted as it
  goes, and its answer. A run that hands app tool calls back waits for the app's answer and
  carries on as the same run. The app is
  told the run's id with every answer. Owner: `agents/run` `createRunService`; the `runs` table
  (the workspace's slug and the agent's name kept beside their ids, which are set to null on
  delete), the `X-Run-Id` header; wraps `agent-core` `runAgentLoop`, in an agent-core runtime of
  its own. The limits are `RUN_DEFAULTS`. GraphQL serves the table read-only, without
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
- **Request options:** what an app that knows the router may add to a request: a task layer's
  text, a narrowing of the agent's servers, and whether to send progress events. Owner:
  `agents/request`; the `ai_router` field of the request body (`task`, `servers`, `progress`).
  Any other key is refused.
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
  `ai_router.progress: true`, chunks with empty `choices` and an `ai_router.event` field, or
  `ai_router: { runId, events }` beside `choices`, holding the events of this request's part of
  the run.
- **App tool (client tool):** a tool the app sends with its request. The agent may call it. The
  run then hands the call back to the app and waits, and resumes when the app sends the result.
  Owner: `agents/request` (`tools`), `agents/run`; passed to the loop as `hostTools`, whose
  dispatch answers with a stand-in and agent-core's `end`, so the loop stops after the step. The
  run then stores its transcript in `runs.resume` and the minted ids in `runs.pending_call_ids`.
- **Conversation:** optional memory of one chat between requests, named by the app and deleted
  once idle, so the app sends only its new messages. One run at a time. Owner:
  `agents/conversation`; the `conversations` table (per workspace and key, with its agent, host
  text, transcript and expiry), `runs.conversation_id`, the `X-Conversation-Id` header, and
  `CONVERSATION_DEFAULTS`. GraphQL serves it read-only, with `Conversation.runs` and
  `Run.conversation`; `/runs/<id>` names it as `conversation`.

### Administration

- **Admin server:** the router's own management, offered as tools on a built-in server, `ai-router`.
  An agent reaches it only by naming it, and its run may use what its workspace's entry for it
  grants. That is the only way in. Owner: `admin/server` `createAdminServer`; `@cubicecho/graphql-mcp`
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
  request, and a run's is handed over in process. Owner: `auth/caller`; `Context.caller`, and
  `RunCaller` from `graphql/handler` `createRunContextFactory`.
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
