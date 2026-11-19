# ai-router

Agents for every app on a network, through one address and one key per app.

An app points any OpenAI client at the router's `/v1` and names an **agent** as its model. The
router runs the agent's whole loop server-side: its prompt, its models (providers and pools the
router keeps), and its tools (MCP servers the router installs and runs, each as its own user).
The app gets an ordinary chat completion back, and the run's record and events afterwards.

It is the agents counterpart of [llm-router](https://github.com/cubicecho/llm-router) and
[mcp-router](https://github.com/cubicecho/mcp-router), which stay for raw models and tools.
Agents are [`cubicecho.agent/1`](https://github.com/cubicecho/agent-core) documents, run with
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
3. **Agents → New agent**: a `cubicecho.agent/1` document as JSON.
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

- **Leading system messages** become the agent's `host` prompt part, and `ai_router.task` a
  `task` part, after the agent's own.
- **Sampling settings** apply as the agent's override policy allows.
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

[AGENTS.md](AGENTS.md) has the layout and the rules, and
[.agents/domain-model.md](.agents/domain-model.md) the concepts.

## License

[MIT](LICENSE)
