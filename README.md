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
  with `Accept: text/event-stream`.

## Development

```bash
npm install
npm run db:up        # a local Postgres on 127.0.0.1:5440
npm run dev          # server and UI
npm run check        # codegen, biome, tsc
npm test             # vitest, on PGlite
```

[AGENTS.md](AGENTS.md) has the layout and the rules, and
[.agents/domain-model.md](.agents/domain-model.md) the concepts.

## License

[MIT](LICENSE)
