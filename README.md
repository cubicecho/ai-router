# ai-router

Agents for every app on a network, through one address and one key per app.

An app points any OpenAI client at the router's `/v1` and names an **agent** as its model. The
router runs the agent's whole loop server-side: its prompt, its models (providers and pools the
router keeps), and its tools (MCP servers the router installs and runs, each as its own user).
The app gets an ordinary chat completion back, and the run's record and events afterwards.
How a request becomes a run, and where its model and tool calls go, is drawn in
[HOW-IT-WORKS.md](HOW-IT-WORKS.md).

It is the agents counterpart of [llm-router](https://github.com/cubicecho/llm-router) and
[mcp-router](https://github.com/cubicecho/mcp-router), which stay for raw models and tools.
Agents are [`cubicecho.agent/2`](https://github.com/cubicecho/agent-core) documents, run with
`@cubicecho/agent-core`.

**Status: early, 0.x.** Models, tools, agents, runs, app tools, progress events and
conversations are built. Moving the apps over, an admin MCP server and more are next: see
[PLAN.md](PLAN.md).

## Quick start

```bash
cp .env.example .env               # set BETTER_AUTH_SECRET: openssl rand -hex 32
docker compose up --wait           # http://localhost:3000, with its own Postgres
```

People sign in through OpenID Connect, or, on a private network, with `SECURE_LOCAL_NET=true`.
`.env.example` explains every setting.

Then, in the UI:

1. **Providers** and **Pools**: the model servers agents may use.
2. **Servers**: MCP servers, from the registry, npm, PyPI or by hand.
3. **Agents → New agent**: a `cubicecho.agent/2` document as JSON.
4. **Workspaces**: one per app, with the agents it may run, its own server settings, and its
   keys.

## Running an agent

| | |
| --- | --- |
| Base URL | `http://<host>:3000/v1` |
| API key | a workspace key |
| Model | the agent's name, from `GET /v1/models` |

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer $WORKSPACE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "personal-finance", "messages": [{"role": "user", "content": "What is due this week?"}]}'
```

- **Leading system messages** become the app's `app_system` prompt part, and `agent_core.prompt`
  adds the app's own parts, after the agent's, as each agent part's `allowedModes` lets them.
- **Every other field** the router doesn't read (`temperature`, `max_tokens`, `top_p`,
  `reasoning_effort`, a provider's own) goes to the agent's model.
- **Response headers:** every answer carries `X-Run-Id`. `Idempotency-Key` makes a retry safe,
  and `X-Conversation-Id` keeps the history for the app.
- **App tools** sent in `tools` are handed back with `finish_reason: "tool_calls"`. Answering
  them resumes the same run.
- **Run records:** `GET /runs/<id>` gives the run, and `GET /runs/<id>/events` its events, live
  with `Accept: text/event-stream`. `POST /runs/<id>/cancel`, with an optional `{ "reason" }`,
  stops a running or waiting run; its stream ends with a `run_cancelled` error.
- **MCP:** an MCP client pointed at `/mcp` with the same key sees each agent as a tool: send a
  `message` (and a `conversation` name to keep history across calls) and get the answer, with
  progress notifications while it runs.
- **Long runs:** a run may take 30 minutes. A stream gets a `: keep-alive` comment every 15
  seconds, so a proxy in front needs a read timeout longer than that. An answer without `stream`
  sends nothing until the run ends, so the proxy's and the client's timeouts must outlast the run:
  the OpenAI SDKs give up after 10 minutes. A dropped connection cancels the run, unless the
  request sent an `Idempotency-Key`.

## Connecting an older app

An app that isn't on the current `@cubicecho/agent-core` (an older `task_server`, or any plain
OpenAI client or SDK) connects like this:

1. **Base URL** `http://<host>:<port>/v1`, and a **workspace key** as `Authorization: Bearer`
   or `x-api-key`. The workspace must list the agents the app runs.
2. **The model is an agent's id**, from `GET /v1/models`. Raw model names such as
   `ollama/qwen3:8b` are not served: they answer 404 `model_not_found`. Each entry carries
   `context_length` when the router knows it, for an app that sizes its history from the list.
3. **Side tasks go to a minimal agent.** An app that makes its own model calls for compaction,
   tool selection or titles should name an agent with only a model, no prompt and no servers,
   rather than its main agent, which would bring its prompt and tools to every one of them:

   ```json
   { "spec": "cubicecho.agent/2", "id": "plain", "model": { "model": "ollama/qwen3:8b" } }
   ```

4. **The app's own tools.** Whatever the app sends in `tools` is an **app tool**: the router
   hands its calls back with `finish_reason: "tool_calls"`, and the app runs them and answers.
   An app that used to load MCP servers itself may keep sending their tools: one with the name
   of one of the agent's own tools is left out, the agent's server answers it, and the answer
   names it in `X-AI-Router-Pruned-Tools`. The same tool under another server name
   (`gh__create_issue` beside `github__create_issue`, with the same input schema) is left out
   too once an admin turns on **Settings → Leave out app tools that are the agent's under
   another server name**. The most tools one request may send is a router setting (128 by
   default).
5. **Fields.** Every field the router doesn't read (`reasoning_effort`, `chat_template_kwargs`,
   `metadata`, `store`, `logprobs` and the like) goes to the agent's model, as it would to any
   OpenAI-compatible server, unless the agent locks it (its page's **Request fields**). A locked
   field, and a newer SDK's `stream_options` key such as `include_obfuscation`, answer 400,
   naming it, until an admin sets **Settings → Locked fields and unread stream options** to
   **Ignore the field**: it is then dropped, and the answer names it in `X-AI-Router-Ignored`
   (a stream option as `stream_options.include_obfuscation`), streamed or not; `include_usage`
   still works. Messages,
   tools, `n` above 1, a `tool_choice` other than `auto`, the older `functions`, and a bad value
   of a field the router reads are refused either way.
6. **Timeouts.** A run without `stream` sends nothing until it ends, which can be long: see
   **Long runs** under [Running an agent](#running-an-agent). Prefer `stream: true`, or raise
   the client's timeout and send an `Idempotency-Key`.

What the router serves:

| Endpoint | |
| --- | --- |
| `GET /v1/models`, `GET /v1/models/<id>` | the agents this key may run |
| `POST /v1/chat/completions` | runs one, streamed or not |
| `GET /runs/<id>`, `GET /runs/<id>/events` | a run of this key's workspace, and its events |

Every other `/v1` path, `/v1/embeddings` and `/v1/completions` included, answers 404.

## Running a worker

A worker runs a workspace's agent loops on another machine, such as your dev box, so its tools
can work on files there. It dials the router, says which tools it has, and takes the runs the
router sends it. Its model calls, and calls to the router's own servers, still go through the
router.

1. Make a worker in the router's UI and copy its key, which starts `aiw_` and is shown once.
2. Point a workspace at it, so its runs go there.
3. On the machine, run its image:

```bash
docker run -d --name ai-router-worker --restart unless-stopped \
  -e AI_ROUTER_URL=http://router.lan:3000 \
  -e AI_ROUTER_WORKER_KEY=aiw_... \
  -e WORKER_HOST=devbox \
  -e WORKER_CONFIG=/config/worker.json \
  -v "$PWD/worker.json:/config/worker.json:ro" \
  -v ai_router_work:/work \
  ghcr.io/cubicecho/ai-router-worker:latest
```

   Its work root is `/work`, a volume, so checkouts outlive the container. Name the machine with
   `WORKER_HOST`, since a container's own hostname is its id. The image has Node and git and nothing
   else, so **local command servers run inside the container**: a server needing another program
   needs an image built on this one, and a `cwd` or a path in its args is a path in the container,
   so mount what it works on. A server reached by `url` works as it is, but `127.0.0.1` there is
   the container: use the host's address, or `--network host` on Linux.

   Or install the worker package, where local servers run on the machine itself. It needs Node 22
   or later, and isn't on a registry yet: each release attaches its tarball, and
   `npm run pack:worker` makes one from a checkout.

```bash
npm install -g https://github.com/cubicecho/ai-router/releases/download/v<version>/cubicecho-ai-router-worker-<version>.tgz
AI_ROUTER_URL=http://router.lan:3000 \
AI_ROUTER_WORKER_KEY=aiw_... \
WORKER_CONFIG=./worker.json \
ai-router-worker
```

   Or run it from a checkout of this repo (`npm ci` once, Node 26) with `npm run worker` and the
   same variables.

   To keep a worker running across reboots, give it a systemd unit:

```ini
# /etc/systemd/system/ai-router-worker.service
[Unit]
Description=ai-router worker
After=network-online.target
Wants=network-online.target

[Service]
User=me
EnvironmentFile=/etc/ai-router-worker.env
# Where `command -v ai-router-worker` says it is: npm's global bin, such as /usr/local/bin.
ExecStart=/usr/local/bin/ai-router-worker
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

   `/etc/ai-router-worker.env` holds the variables below, one `NAME=value` a line; make it
   readable by root only (`chmod 600`), since it holds the key. Then `systemctl enable --now
   ai-router-worker`. Systemd sends `SIGTERM` to stop it, which finishes its runs as failed, and a
   restarted worker's hello tells the router which runs it lost, so they fail at once.

| Variable | |
| --- | --- |
| `AI_ROUTER_URL` | the router's address. Required |
| `AI_ROUTER_WORKER_KEY` | the worker's key. Required |
| `WORKER_ROOT` | where its work directories go. Default `~/ai-router-work`, made if missing; `/work` in the image |
| `WORKER_CONFIG` | a JSON file naming its own MCP servers. Optional |
| `WORKER_HOST` | the machine's name, as the router shows it. Default the hostname |

```json
{
  "servers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/ai-router-work"] },
    "tests": { "command": "node", "args": ["scripts/test-mcp.js"], "env": { "CI": "1" }, "cwd": "../my-app" },
    "notes": { "url": "http://127.0.0.1:8123/mcp", "headers": { "authorization": "Bearer ..." } }
  }
}
```

Every worker also has the built-in `workdir` server: `open_repo` clones a repo under the work
root, or returns the checkout already there, at `<root>/<host>/<owner>/<name>` (for example
`~/ai-router-work/github.com/cubicecho/ai-router`), and `list_dir` lists a folder inside it.
Nothing either tool touches is outside the root.

**Local servers run as you.** A command server runs as the worker's user on that machine, with
your trust, unlike the router's own servers, which run sandboxed as their own users. It gets
only `PATH`, `HOME`, `LANG`, `TERM` and `USER` from the worker's environment, plus its own
`env`, never the worker's key. A `cwd` is relative to the config file. A server name follows the
router's name rule (lowercase letters, digits, `.`, `-`, `_`); one that breaks it, or fails to
start, is left out with a `[worker]` line. A server that says its tools changed is listed
again, and the router told.

The worker dials the router again whenever its channel drops, waiting longer after each failed
dial, and keeps its runs going meanwhile. `Ctrl-C` or `SIGTERM` stops its runs, reporting each as
failed, and closes its servers.

## Development

```bash
npm install
npm run db:up        # a local Postgres on 127.0.0.1:5440
npm run dev          # server and UI
npm run check        # codegen, biome, tsc
npm test             # vitest, on PGlite
```

`npm run db:up` binds Postgres to the Docker host's loopback. When that host is another machine
(`docker context ls`), reach it through a tunnel, `ssh -fN -L 127.0.0.1:5440:127.0.0.1:5440 <host>`,
and `.env.example`'s `DATABASE_URL` works as it is. Or start it with `DEV_BIND=0.0.0.0`, which
exposes it on the network, and put the host's name in `DATABASE_URL`.

### A preview beside the released router

A push to `feat/workers` that passes CI publishes `ghcr.io/cubicecho/ai-router:workers` (it moves with
the branch) and `:workers-<short sha>` (`.github/workflows/preview.yml`), and the worker program as
`ghcr.io/cubicecho/ai-router-worker` under the same tags: use `:workers` in place of `:latest` above. Nothing is released or
tagged, and `:latest` is untouched. Run it as a compose project of its own, so it gets its own
Postgres volume, since the branch's migrations can't be undone on the released router's database:

```bash
AI_ROUTER_IMAGE=ghcr.io/cubicecho/ai-router:workers PORT=3001 \
  docker compose -p ai-router-preview up --no-build --wait
```

Give it its own `BETTER_AUTH_SECRET` and `APP_URL` (`http://<host>:3001`), and its own OIDC client.
Workspace keys are its own too: make them in its UI.

[AGENTS.md](AGENTS.md) has the layout and the rules, and
[.agents/domain-model.md](.agents/domain-model.md) the concepts.

## License

[MIT](LICENSE)
