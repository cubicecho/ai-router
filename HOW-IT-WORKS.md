# How ai-router works

Diagrams of what the router does today: what a workspace decides, how an app's request becomes a run, what
one run does, and where its model and tool calls go. The words are the glossary's, in
[`.agents/domain-model.md`](.agents/domain-model.md); the code each step names is the place to read for how.
What happens inside the loop itself (turns, tool loading, the system prompt) is agent-core's, in its own
[`HOW-IT-WORKS.md`](../agent-core/HOW-IT-WORKS.md).

- [The pieces](#the-pieces)
- [What a workspace decides](#what-a-workspace-decides)
- [From a request to a resolved run](#from-a-request-to-a-resolved-run)
- [One request on `/v1`](#one-request-on-v1)
- [One run](#one-run)
- [A model call](#a-model-call)
- [A tool call](#a-tool-call)
- [Waiting for the app](#waiting-for-the-app)
- [How a run ends](#how-a-run-ends)
- [What the app gets back](#what-the-app-gets-back)
- [An agent call as an MCP task](#an-agent-call-as-an-mcp-task)
- [Run events](#run-events)
- [Conversations and sessions](#conversations-and-sessions)
- [The snapshot](#the-snapshot)

## The pieces

An app reaches the router with a **workspace key**, and a person with a session. The app sees only agents.
The models and MCP servers behind them are the router's own.

```mermaid
flowchart LR
  subgraph Apps["Apps, with a workspace key"]
    oai["Any OpenAI client<br/>min-agent, task_server, telos"]
    mcpc["An MCP client"]
  end
  subgraph People["People"]
    person["A user, with a session"]
  end

  subgraph Router["ai-router"]
    v1["/v1<br/>agents endpoint"]
    mcpdoor["/mcp<br/>agents MCP door"]
    runsr["/runs<br/>run records"]
    gql["/graphql"]
    snap[("Snapshot")]
    runsvc["Run service<br/>agents/run"]
    loop["agent-core<br/>runAgentLoop"]
    fwd["Forwarder<br/>models/forward"]
    inst["Instances<br/>tools/instances"]
    admin["Admin server ai-router<br/>admin/server"]
    bus["Run bus"]
    db[("Postgres")]
  end

  prov[("Providers<br/>model servers")]
  mcps[("MCP servers<br/>child processes or addresses")]

  oai --> v1
  oai --> runsr
  mcpc --> mcpdoor
  person --> gql
  v1 --> runsvc
  mcpdoor --> runsvc
  runsvc --> loop
  loop -- "model calls, in process" --> fwd --> prov
  loop -- "tool calls" --> inst --> mcps
  inst -- "in process" --> admin --> gql
  runsvc -- "events" --> bus --> db
  runsr --> bus
  v1 -. "reads" .-> snap
  fwd -. "reads" .-> snap
  inst -. "reads" .-> snap
  gql -- "writes, then rebuilds" --> db
  db --> snap
```

There is no raw model or tool endpoint. The forwarder is called only by a run's `fetch`, and the admin
server only through the instances, as any other server a run reaches.

Who a request is from is read once, from its credential (`auth/caller`):

| Credential | Caller | Reaches |
| --- | --- | --- |
| A workspace key, as `Authorization: Bearer` or `x-api-key` | An app, as its workspace | `/v1`, `/mcp`, `/runs`. A session token sent there is refused |
| A session cookie or token | A user, or an admin | `/graphql` and the UI. Under `SECURE_LOCAL_NET`, whoever opens the UI is the admin |
| None: handed over in process | A run, as `RunCaller` | The admin server's tools, as far as its workspace's roles reach |

## What a workspace decides

A workspace owns nothing. It is a set of choices about agents and servers that live on their own, and its
keys carry those choices to every request.

```mermaid
flowchart TB
  key["Workspace key<br/>workspace_keys: SHA-256 only"] --> ws["Workspace"]

  ws -- "which agents it may run" --> wa["workspace_agents"]
  wa -- "per agent: which servers<br/>its runs there reach" --> grant["Server grants<br/>workspace_agent_servers"]
  ws -- "how each server is set up<br/>for its runs" --> entry["Server entries<br/>workspace_servers"]

  agent["Agent<br/>live revision: model, prompt"] --> wa
  server["Server<br/>base settings"] --> grant
  server --> entry

  entry -- "overrides env, args,<br/>headers or URL" --> wsinst["Workspace instance<br/>its own uid and HOME"]
  entry -- "overrides nothing,<br/>or no entry" --> base["Base instance"]
  entry -- "for ai-router only" --> roles["Roles"]
```

- **A grant reaches, an entry configures.** A run reaches exactly the servers its workspace granted its
  agent, and none without a grant. An entry never grants a server; it only decides which instance a granted
  one is called on.
- **The agent's document decides its models.** Its own `tools.servers` is ignored (a save warns).
- **Only a person grants.** `setWorkspaceAgentServers` is people-only, and no admin-server role reaches it,
  so a run can never widen its own reach.
- **Roles live on the entry for `ai-router`** and nowhere else. They decide which management tools a
  granted run is listed, and the schema's permissions guard each call.

## From a request to a resolved run

Three layers are stacked weakest first and merged by agent-core's `resolveAgentSpec`, and then the app's
parts are stacked on the result by `stackAppParts` (`agents/layers` `resolveRun`).

```mermaid
flowchart TB
  subgraph L1["1 · router layer"]
    r1["endpoint: the router's internal model address"]
  end
  subgraph L2["2 · agent layer: the live revision"]
    a1["model, prompt parts, side tasks"]
    a2["tools.servers: replaced by the workspace's grant"]
  end
  subgraph L3["3 · request layer: only if the request sets something"]
    q1["temperature, max_tokens, extraBody"]
    q2["agent_core.servers: intersected with the grant"]
  end
  subgraph AP["App parts, after resolving"]
    p1["agent_core.prompt, each named app_…"]
    p2["leading system and developer messages, as app_system"]
  end
  R["Resolved agent and stacked prompt"]
  F["withRouterFetch: every endpoint at the router's<br/>address gets the run's fetch"]

  L1 --> L2 --> L3 --> R
  AP --> R
  R --> F --> loop(["the run's config"])
```

What passes into those layers is read first, by `agents/request` `readRunRequest`. Every field the router
doesn't read itself goes to the model, so an OpenAI client's request goes through as it would to OpenAI,
unless the agent locks it (agent-core's `checkLockedFields`, against the agent resolved alone):

| A request field | Goes to | Refused when |
| --- | --- | --- |
| `model` | Picks the agent. Never changes its model | The workspace may not run it: 404 `model_not_found` |
| `messages` | Leading `system`/`developer` → `app_system`; the rest → the conversation; trailing `tool` messages → answers to a waiting run | Empty, or nothing after the system messages |
| `temperature` | `model.temperature` | Out of range |
| `max_tokens`, `max_completion_tokens` | `model.maxTokens` | Not a whole number, or the two disagree |
| `reasoning_effort` | `model.reasoningEffort` | |
| `response_format`, `parallel_tool_calls` | `model.extraBody` | Not the right shape |
| `tools` | App tools, handed back when called | More than the settings allow, a name of the loop's own, or not function tools |
| `agent_core.prompt` | App parts | agent-core's `parseAppParts` can't read one |
| `agent_core.servers` | Narrows the workspace's servers | |
| `agent_core.progress` | Progress events in the answer | |
| `user` | Recorded on the run | |
| `n` | | Above 1 |
| `stream_options` keys but `include_usage` | | Refused, naming the key; under `unlistedFields: ignore`, dropped and named in `X-AI-Router-Ignored` |
| A field the agent locks (`model.lockedFields`) | | Refused, naming it; under `unlistedFields: ignore`, dropped and named in `X-AI-Router-Ignored` |
| Any other field (`top_p`, `seed`, `stop`, a provider's own) | `model.extraBody` | |

Nothing above the agent names an endpoint or a model, and a sampling setting never reaches a side task. An
app part that breaks its agent part's `allowedModes` is dropped, not refused: a notice event, and
`agent_core.warnings` on the answer.

## One request on `/v1`

`POST /v1/chat/completions`, in `agents/routes` `createAgentRoutes`.

```mermaid
flowchart TB
  req(["POST /v1/chat/completions"]) --> key{"a workspace key?<br/>appCaller"}
  key -- "no, or two that differ" --> r401["401 / 400"]
  key -- "yes" --> idem{"Idempotency-Key<br/>already used?"}
  idem -- "same body" --> repeat["answer that run again<br/>waiting for it if it's still going"]
  idem -- "other body" --> r422["422"]
  idem -- "no" --> agent{"runnableAgent:<br/>granted, with a live revision?"}
  agent -- "no" --> r404["404 model_not_found"]
  agent -- "yes" --> read["readRunRequest"]
  read -- "refused" --> r400["400, naming the field"]
  read --> hdr1["X-AI-Router-Ignored"]
  hdr1 --> conv["X-Conversation-Id → openConversation<br/>X-Session-Id → session key"]
  conv --> answers{"trailing tool messages?"}
  answers -- "yes" --> waiting["waitingFor: the run that handed<br/>exactly those calls back"]
  waiting --> resumed["resumedLayers: the run's own system<br/>messages, parts, servers, sampling"]
  resumed --> resolve2["resolveRun over the revision it started with"]
  resolve2 --> resume["runs.resume"]
  answers -- "no" --> begin["beginRun: history, resolveRun,<br/>fetchFor, runs.begin"]
  resume --> hdr2
  begin --> hdr2["X-Run-Id, X-AI-Router-Pruned-Tools"]
  hdr2 --> stream{"stream?"}
  stream -- "yes" --> chunks["openChunkStream: text, reasoning<br/>or progress events, keep-alives"]
  stream -- "no" --> json["completionBody when the run ends"]
```

- **Before the run exists**, a refusal is OpenAI's `{ error: { message, type, code } }` and carries no
  `X-Run-Id`. A run the router never recorded leaves no trace.
- **Every header is set before the first byte**, so a streamed answer carries them too.
- **A dropped connection** cancels the run, unless the request sent an `Idempotency-Key`: that run goes on to
  its timeout, so the retry gets its answer.
- **`/mcp`** (`agents/mcp`) builds the same request from a tool call's `message`, with no app tools and no key,
  and calls the same `beginRun`, so its runs never wait. A call may ask to run as an MCP task: see
  [An agent call as an MCP task](#an-agent-call-as-an-mcp-task). `GET /v1/models` lists the same agents
  (`runnableAgents`), each marked `agent_core: { kind: "agent", prompt }` with its parts' names and
  `allowedModes`, never their text.

## One run

`agents/run` `createRunService`: `begin` records the run, and `run` drives one stretch of it, from its start
or a resume to its answer or a wait.

```mermaid
sequenceDiagram
  autonumber
  participant Route as /v1 route
  participant Svc as Run service
  participant Inst as Instances
  participant Core as runAgentLoop
  participant Fwd as Forwarder
  participant Bus as Run bus
  participant DB as runs table

  Route->>Svc: begin(input)
  Svc->>Svc: conversation busy? 409
  Svc->>Inst: reachedTools: listTools per granted server
  Inst-->>Svc: tools, or a notice for each server that failed
  Svc->>Svc: runToolNames, pruneAppTools
  Svc->>DB: insert running row (or find the Idempotency-Key's run)
  Svc->>Bus: open
  Svc-->>Route: StartedRun
  Route->>Svc: execute(listener, signal)
  Svc->>Bus: notices: servers left out, app tools pruned, parts dropped
  Svc->>Core: config, prompt parts, messages, tools, hostTools, dispatch
  loop each turn
    Core->>Fwd: model request, through the run's fetch
    Fwd-->>Core: streamed reply, usage counted
    Core->>Svc: onEvent: turn, thinking, output, calls, results, usage
    Svc->>Bus: publish, numbered
    Svc-->>Route: onText / onEvent
    Svc->>DB: token totals so far
    opt the model calls the agent's tools
      Core->>Svc: dispatch(call)
      Svc->>Inst: callTool on the workspace's instance
      Inst-->>Svc: result
      Svc-->>Core: result, or an error for the model
    end
    opt the model calls an app tool
      Core->>Svc: dispatch(call)
      Svc-->>Core: a stand-in, and end: the loop stops after this turn
    end
  end
  Core-->>Svc: messages, usage, outcome
  alt calls were handed back
    Svc->>DB: waiting, pending_call_ids, resume
  else answered
    Svc->>DB: completed, answer, tokens
    Svc->>Svc: keep the transcript in its conversation
  else failed or cancelled
    Svc->>DB: failed or cancelled, error
  end
  Svc->>Bus: done, then close
  Svc-->>Route: FinishedRun
```

- **The run keeps the revision it started with.** A revision promoted while it runs applies to the next one.
- **A server that won't start or list** is left out with a notice; it never fails the run.
- **Each tool gets a model name** by `agents/tool-names` `runToolNames`: `<server>__<tool>`, with any character
  outside `[a-zA-Z0-9_-]` made `_`, and a name over 64 characters or shared by two tools cut and hashed. The
  map back to the server and tool lives for this run only.
- **An app tool that duplicates the agent's own** is pruned (`agents/app-tools`): always for the same name, and
  across servers only under `pruneAppToolsAcrossServers`. The agent's server answers it instead.
- **Every app tool call gets an id the router minted** (`freshCallId`), in the answer, the events and the
  transcript alike, and a repeated identical call is handed back again, never answered from the first.
- **The loop's `session` is the run id,** which agent-core sends as `X-Session-Id` on each model call, so a
  sticky pool (`models/affinity`) keeps one run's calls on one target.

## A model call

The router layer sets every agent's endpoint to `MODELS_BASE_URL`, an address that resolves nowhere. The
run's `fetch`, made once per workspace and agent by `Forwarder.fetchFor`, answers it in process. An agent
with an `endpoint.baseUrl` of its own is called directly, with no key and no `fetch`.

```mermaid
flowchart TB
  loop["runAgentLoop / side task"] -- "POST MODELS_BASE_URL/chat/completions" --> fetch["the run's fetch<br/>makeFetch"]
  fetch -- "another address" --> r404["404: a run calls only its own models"]
  fetch -- "GET /models" --> list["listModels: pools, then each<br/>provider's cached listing"]
  fetch --> forward["forward"]
  forward --> route{"route: does model name a pool?"}
  route -- "a pool" --> bal["balancer.acquire:<br/>least busy, in turn, random or sticky,<br/>by weight, passing over down targets"]
  bal --> lease["a lease on one target"]
  route -- "provider/model" --> prov["split at the first /"]
  lease --> ask["ask: the provider's key and headers,<br/>stream_options.include_usage on"]
  prov --> ask
  ask -- "could not be reached" --> mark["markUnreachable,<br/>try the pool's next target"]
  mark --> route
  ask -- "answered, or timed out,<br/>or an error answer" --> pass["passThrough: the stream as it comes,<br/>reading its usage"]
  pass --> settle["settle, once: release the lease,<br/>count usage on a 2xx"]
```

- **A pool call goes to the next target only when nothing reached the first**, so no provider has done any
  of it. A timeout or an error answer is passed back.
- **Usage counts under the run's workspace and agent**, and under the pool as well as the target it went to
  (`models/usage`, written every few seconds).
- **Health checks** (`models/health`) ask each provider an enabled pool uses for its model list once a round,
  and a target found down is passed over until a later round finds it up.

## A tool call

The run's `dispatch` maps the model's name back to a server and tool and calls `ToolServices.callTool` with
the run's workspace, so the workspace's instance and secrets are used.

```mermaid
flowchart TB
  disp["dispatch(call)"] --> names["the run's name map:<br/>server, tool"]
  names --> svc["tools.callTool(server, workspace, tool, args,<br/>agent, run)"]
  svc --> resolve{"resolveServer: does the workspace's<br/>entry override anything?"}
  resolve -- "yes" --> wsi["workspace instance<br/>env and headers merged, args and URL replaced"]
  resolve -- "no, or no entry" --> base["base instance"]
  wsi --> kind{"transport"}
  base --> kind
  kind -- "stdio" --> child["run-as-child uid -g gid -- command<br/>argument array, env allowlist plus its own"]
  kind -- "streamable-http / sse" --> http["the address, with its headers and login"]
  kind -- "builtin: ai-router" --> adm["the admin server, in process<br/>one instance per workspace, with its roles"]
  child --> act["activity: tool, time, failure,<br/>agent, run, workspace"]
  http --> act
  adm --> act
  adm -- "_meta names the run" --> gql["the permissioned GraphQL schema,<br/>as RunCaller"]
```

- **A stdio instance starts on its first call** and stops when idle. A workspace instance runs as its entry's
  own uid with the server's group, in the server's install folder, with a HOME of its own.
- **The admin server's tools are listed as far as the roles reach** (`canReachField`), and every call is
  checked by the same permissions `/graphql` has. The run is named in `_meta` by the router's dispatch,
  never by the model.
- **A run never changes or restarts `ai-router`**, never grants a server, and never promotes: its saves are
  drafts, unless a user turned on auto-promote for that agent.
- **A tool's error reaches the model as an error,** and the loop goes on.

## Waiting for the app

An app tool call pauses the run. The app answers it with an ordinary OpenAI tool round trip, and the same
run carries on under the same run id.

```mermaid
sequenceDiagram
  autonumber
  participant App
  participant Route as /v1 route
  participant Svc as Run service
  participant DB as runs table
  participant Core as runAgentLoop

  App->>Route: messages, tools
  Route->>Svc: begin, execute
  Svc->>Core: run
  Core-->>Svc: the agent's own calls in the step run first,<br/>then the app's call ends the loop
  Svc->>DB: waiting: transcript, loaded tools, layers,<br/>app tools as sent, pending_call_ids
  Svc-->>App: finish_reason tool_calls, under minted ids
  Note over App: runs its own tools
  App->>Route: the same messages, plus a tool message per call
  Route->>Svc: waitingFor(workspace, agent, answered ids)
  Svc->>DB: the run whose pending ids are exactly these
  alt a call unanswered, or one answered that wasn't handed back
    Svc-->>App: 400
  else expired or cancelled
    Svc-->>App: 409 run_expired / run_cancelled
  else every call answered
    Route->>Route: resumedLayers: different system messages or parts are refused
    Route->>Svc: resume
    Svc->>DB: running again, the answers appended to input
    Svc->>Core: the stored transcript, with the app's answers in place
    Core-->>Svc: carries on
    Svc-->>App: the answer, or more handed-back calls
  end
```

- **A wait survives a restart.** Everything the loop needs is on the row (`runs.resume`), and a resume rebuilds
  agent-core's state from it.
- **Waiting doesn't count toward the run timeout.** Waiting past `RUN_DEFAULTS.waitTimeoutHours` expires it.
- **The app's tools are pruned again on each resume**, against the agent's tools as they are now.
- **A resume takes over the run's `Idempotency-Key`**, or clears it, so a retry of the resume gets the
  resume's answer.

## How a run ends

```mermaid
stateDiagram-v2
  [*] --> Refused: the key, the agent or the request is refused
  [*] --> Running: recorded
  Running --> Completed: the model answered
  Running --> Waiting: an app tool was called
  Waiting --> Running: the app answered every call
  Waiting --> Expired: no answer within the wait timeout
  Waiting --> Cancelled: POST /runs/id/cancel or cancelRun
  Waiting --> Waiting: the router restarted
  Running --> Cancelled: cancelled, or an app without a key disconnected
  Running --> Failed: an error, past the run timeout, or the router stopped
  Refused --> [*]
  Completed --> [*]
  Expired --> [*]
  Cancelled --> [*]
  Failed --> [*]
```

- **A refused request is not recorded.** Everything from `running` on is, with the revision it ran.
- **Every end sends one last `done` event**, and a run that was going when the router stopped is marked failed,
  with its `done`, at the next boot (`runs.recover`).
- **Once a run has ended, its record and events never change.** A cancel of an ended run answers with it
  unchanged. Only retention deletes it.

## What the app gets back

| The app sends | It gets |
| --- | --- |
| `stream: true`, no `agent_core.progress` | `chat.completion.chunk`s: the answer as `content`, the run's thinking and a line per tool call and result as `reasoning_content`, which chat clients fold away |
| `stream: true`, `agent_core.progress: true` | The answer as `content`, and each run event as a chunk with empty `choices` and `agent_core.event`, never as reasoning too |
| No `stream` | One `chat.completion` when the run ends, with `agent_core: { runId, events }` beside `choices` when progress was asked for |
| `stream_options.include_usage` | A usage chunk at the end |
| A repeated `Idempotency-Key` | The same run's answer, without its events; the app reads them from `/runs/<id>/events` |

Every answer carries `X-Run-Id`. `X-AI-Router-Ignored` names fields dropped under `unlistedFields: ignore`,
`X-AI-Router-Pruned-Tools` the app tools left out, and `agent_core.warnings` the app parts dropped (beside
`choices`, or on the finish chunk). A stream gets a `: keep-alive` comment every `heartbeatSeconds`.

Afterwards, or while it runs, the same key reads its workspace's runs at `/runs`:

| | |
| --- | --- |
| `GET /runs` | Its runs, newest first; `?session=` for one session's |
| `GET /runs/<id>` | Agent, revision, session, conversation, status, input, timings, usage, error |
| `GET /runs/<id>/events` | The events as JSON, or live with `Accept: text/event-stream`, rejoined with `Last-Event-ID` |
| `POST /runs/<id>/cancel` | Cancels a running or waiting run, with an optional `{ reason }` |

Another workspace's run is the same 404 as one that never was. Refusals here are `{ error, code }`.

## An agent call as an MCP task

A `/mcp` call that asks to run as a task (MCP's 2025-11-25 tasks) is answered at once, and the run goes on without
the connection. The task is the run: `agents/mcp-tasks` answers every task method from the runs table and the run bus,
so there is no second store.

```mermaid
sequenceDiagram
  autonumber
  participant Client as MCP client
  participant Door as /mcp
  participant Svc as Run service
  participant Bus as Run bus

  Client->>Door: tools/call with task
  Door->>Svc: beginRun, execute in the background
  Door-->>Client: the task: id = run id, working
  Note over Client: the connection may close, and the run goes on
  Client->>Door: tasks/result (with a progress token)
  Door->>Bus: watch the run
  loop each event
    Bus-->>Door: RunEvent
    Door-->>Client: progress notification, the RunEvent in _meta, linked to the task
  end
  Door-->>Client: the agent's answer, _meta.runId
```

| Task method | Does |
| --- | --- |
| `tasks/get` | The run as a task: running is `working`, waiting is `input_required`, completed `completed`, failed and expired `failed`, cancelled `cancelled` |
| `tasks/result` | Waits for the run's end, sending each of its events on the way, then answers as the call would have |
| `tasks/list` | The workspace's runs, newest first |
| `tasks/cancel` | Cancels the run, as `POST /runs/<id>/cancel` does. An ended task can't be cancelled |

A key reaches only its own workspace's tasks. A caller that only polls `tasks/get` sees the status, and any caller can
also follow `/runs/<id>/events` with the same key.

## Run events

Events are agent-core's `RunEvent`, unchanged, written as JSON. The run bus (`agents/run-bus`) numbers them
and hands each to every follower, and writes them to the table folded.

```mermaid
flowchart LR
  loop["runAgentLoop events<br/>and the router's notices and done"] --> pub["bus.publish<br/>seq 1, 2, 3… with no gap,<br/>never restarted"]
  pub --> live["followers, from memory:<br/>the answer's stream, /runs/id/events,<br/>the runEvents subscription"]
  pub --> held["held in memory"]
  held -- "every eventFlushMs, and when<br/>the run waits or ends" --> fold["fold: each stretch of thinking or output<br/>becomes one row, under its last event's seq"]
  fold --> table[("run_events<br/>with text_ends")]
  table --> late["a reader who joins late:<br/>stored rows first, then live"]
```

- **Stored `seq`s increase with gaps.** Never number stored rows, and never assume `seq + 1` is stored.
- **A stretch still going** stays in memory until it ends, or for `RUN_DEFAULTS.streamHoldMs`, and is then stored
  in parts.
- **A reader who had part of a stretch live** gets only the rest of its row, by `text_ends`.
- **The run's input is not an event.** What each request added is on `runs.input`, since apps already show their
  own input.

## Conversations and sessions

Both are optional, named by the app, and kept per workspace.

```mermaid
flowchart TB
  subgraph Conv["X-Conversation-Id: memory"]
    direction TB
    c1["the request's new messages"] --> c2["withHistory: the last completed run's<br/>transcript and system messages before them"]
    c2 --> c3["one run at a time:<br/>an overlap gets 409 conversation_busy"]
    c3 --> c4{"how did the run end?"}
    c4 -- "completed" --> c5["its transcript becomes the history"]
    c4 -- "failed, cancelled, waiting" --> c6["the history stays as it was;<br/>only the expiry moves on"]
  end
  subgraph Sess["Session: a label"]
    direction TB
    s1["the conversation's key,<br/>else X-Session-Id"] --> s2["runs.session_key"]
    s2 --> s3["groups runs across agents:<br/>GET /runs?session=, the Sessions tab"]
  end
```

- **A conversation belongs to one workspace and one agent.** Once it has history, a request that sends assistant
  or tool messages is refused, except tool messages that answer its waiting run.
- **App parts are not kept**: each request sends its own. System messages are, until a request sends new ones.
- **An idle conversation is deleted** after `CONVERSATION_DEFAULTS.idleHours`, never while it has a run going.
  Its runs stay, naming none.
- **A session never decides how a run goes.** Nothing reads it but the listings.

## The snapshot

Requests never read routing from the database. `db/snapshot` holds keys, workspaces and their grants and
entries, agents and their live documents, providers, pools, servers and settings in memory.

```mermaid
flowchart LR
  write["a GraphQL mutation,<br/>a server login, an install"] --> tx["its transaction commits"]
  tx --> rebuild["snapshot.rebuild:<br/>loadSnapshot"]
  rebuild --> snap[("Snapshot")]
  snap --> v1["/v1, /mcp, /runs:<br/>keys, agents, grants"]
  snap --> fwd["forwarder: providers, pools"]
  snap --> inst["instances: servers, entries, secrets"]
```

- **A request reads the snapshot once** and routes by that copy to its end.
- **One process owns a database**: a Postgres advisory lock taken at boot, so a second router refuses to start.
- **Boot** waits for Postgres, takes the lock, runs the migrations, upgrades stored documents and waiting runs
  once (`agents/upgrade`), checks that children are walled off, then marks the runs a stop cut short as failed
  and starts the timers: usage, pool health, activity, and run retention and expiry.
