# [0.13.0](https://github.com/cubicecho/ai-router/compare/v0.12.0...v0.13.0) (2026-11-20)

* feat(agents)!: a workspace decides which MCP servers each agent uses ([50c3de5](https://github.com/cubicecho/ai-router/commit/50c3de59148ae3c09d7df67eea31904ff9e2d5bb))

### BREAKING CHANGES

* an agent's tools.servers is ignored, and an agent in a
  workspace reaches no MCP servers until a person grants them on the
  workspace's Agents tab. Existing workspaces start with none.

# [0.12.0](https://github.com/cubicecho/ai-router/compare/v0.11.0...v0.12.0) (2026-11-20)

### Features

* **web:** one look for every list, tab and title ([3c8409d](https://github.com/cubicecho/ai-router/commit/3c8409dbad729eea8a682de7ff04d16c55312a02)), closes [#41](https://github.com/cubicecho/ai-router/issues/41)

# [0.11.0](https://github.com/cubicecho/ai-router/compare/v0.10.0...v0.11.0) (2026-11-20)

* feat(agents)!: run agents on agent-core 7's prompt spec ([913a814](https://github.com/cubicecho/ai-router/commit/913a814aff62f492abd496e42985959ec8f8bae3))

### Features

* **web:** edit prompt parts by name, with the modes apps may use and the layout ([4056cc5](https://github.com/cubicecho/ai-router/commit/4056cc59b48c01a842d3dfced2f67f50eb27f645))

### BREAKING CHANGES

* apps send ai_router's fields as agent_core, and read
  progress and the model list's agent marker under agent_core too. The
  task field is removed: send the job as the user message, or as an app
  part. System messages are always taken, after the agent's parts.

# [0.10.0](https://github.com/cubicecho/ai-router/compare/v0.9.0...v0.10.0) (2026-11-19)

### Features

* **runs:** a session's title, how it went and how long it took ([ed0846c](https://github.com/cubicecho/ai-router/commit/ed0846c00d5431de933a8fb4b5b215ea5ef7c7c7))
* **web:** session rows show their title, failures and time ([bdd23a1](https://github.com/cubicecho/ai-router/commit/bdd23a180acca275a9975492247b66b149ebabf6))

# [0.9.0](https://github.com/cubicecho/ai-router/compare/v0.8.0...v0.9.0) (2026-11-19)

### Features

* **runs:** record each run's session, and list sessions ([c46a5a2](https://github.com/cubicecho/ai-router/commit/c46a5a276beaa3177689f15fa6dc7cfb9a9549fe)), closes [#38](https://github.com/cubicecho/ai-router/issues/38)
* **web:** a Sessions tab on the runs screen ([f1c02f6](https://github.com/cubicecho/ai-router/commit/f1c02f6e2904dc8ba2d2161086e9f7909b567c8c)), closes [#38](https://github.com/cubicecho/ai-router/issues/38)

# [0.8.0](https://github.com/cubicecho/ai-router/compare/v0.7.0...v0.8.0) (2026-11-19)

### Bug Fixes

* one RunnableAgent, from start.ts, after merging the cancel and MCP work ([d0a70e2](https://github.com/cubicecho/ai-router/commit/d0a70e2441a5c8801a3613a09344c6c085acea35))

### Features

* **mcp:** offer agents as MCP tools on /mcp ([0df5f90](https://github.com/cubicecho/ai-router/commit/0df5f90698d8422b3fb6e1b9bcdb58eef7706e76)), closes [#31](https://github.com/cubicecho/ai-router/issues/31)
* **models:** check pool targets' health in the background, and weigh targets ([9264e0f](https://github.com/cubicecho/ai-router/commit/9264e0ff43310f51ac2e8379f4622b1a8673e865)), closes [#29](https://github.com/cubicecho/ai-router/issues/29)
* **models:** count usage per pool, and show it on the pool page ([9ec7ebc](https://github.com/cubicecho/ai-router/commit/9ec7ebc411ed71ec8ee74c5deea895285f5020f1)), closes [#23](https://github.com/cubicecho/ai-router/issues/23)
* **models:** let people price models and pools, and show cost beside usage ([35078a7](https://github.com/cubicecho/ai-router/commit/35078a7c419e7f17e74f1475dc2b4e04c5ca1871)), closes [#30](https://github.com/cubicecho/ai-router/issues/30)
* **policies:** several override policies, chosen per agent, with a UI ([7196f56](https://github.com/cubicecho/ai-router/commit/7196f56055f19d7e29ab48e3ee6c9f6b41ffea8c)), closes [#28](https://github.com/cubicecho/ai-router/issues/28)
* **runs:** cancel a running or waiting run with POST /runs/<id>/cancel ([2d027b2](https://github.com/cubicecho/ai-router/commit/2d027b242ed919d6135edacb517b4f040c56591a)), closes [#27](https://github.com/cubicecho/ai-router/issues/27)

# [0.7.0](https://github.com/cubicecho/ai-router/compare/v0.6.0...v0.7.0) (2026-11-19)

### Bug Fixes

* **tools:** reconnect an SSE server that lost the session, and knock on its stream for a login ([9dda76a](https://github.com/cubicecho/ai-router/commit/9dda76ab6874c968b64d70646dc33ba43a64658e)), closes [#21](https://github.com/cubicecho/ai-router/issues/21)
* **web:** the shared tab bar keeps the tabs at their own width, under the title ([2d45d02](https://github.com/cubicecho/ai-router/commit/2d45d029ccf80c3c99542de257f38cf781ed3e9c))

### Features

* **agents:** answer GET /v1/models/{id} with the list's entry, and model_not_found otherwise ([7032826](https://github.com/cubicecho/ai-router/commit/7032826f3438e987e4c6e207b618c05adb333483)), closes [#16](https://github.com/cubicecho/ai-router/issues/16)
* **agents:** give each /v1/models entry the context_length its model reads ([3a1ad8b](https://github.com/cubicecho/ai-router/commit/3a1ad8b762ec62425521bf9f557b5f3976b1d3f7))
* **agents:** ignore unknown stream_options keys when the router ignores unlisted fields ([6c5da32](https://github.com/cubicecho/ai-router/commit/6c5da3251e1618bea605652b5898b13ba13d0d35)), closes [#24](https://github.com/cubicecho/ai-router/issues/24)
* **agents:** prune app tools that duplicate the agent's own instead of refusing them ([d69b130](https://github.com/cubicecho/ai-router/commit/d69b130dafdc3354373f2ed923d4b9923a2f39b8)), closes [#15](https://github.com/cubicecho/ai-router/issues/15)
* **settings:** choose whether /v1 refuses or ignores request fields the policy doesn't list ([8e44873](https://github.com/cubicecho/ai-router/commit/8e44873c4438c83afb590ed179dbdf3be76c143d))
* **tools:** record which run made an admin-server tool call, and show it on the Activity tab ([ff55d8c](https://github.com/cubicecho/ai-router/commit/ff55d8c32d09f1cdde6542a81422726ab0461120)), closes [#20](https://github.com/cubicecho/ai-router/issues/20)
* **web:** drop section headings that repeat their tab's name, keeping descriptions ([0f9fd8e](https://github.com/cubicecho/ai-router/commit/0f9fd8ee6b8915a4e552d97ad6456159bcc7e253)), closes [#25](https://github.com/cubicecho/ai-router/issues/25)

# [0.6.0](https://github.com/cubicecho/ai-router/compare/v0.5.1...v0.6.0) (2026-11-19)

### Features

* **runs:** keep each run's input, and store its events folded ([6239974](https://github.com/cubicecho/ai-router/commit/6239974a778aad3e92db31f08463e59c13c13431))
* **settings:** let an admin set the app-tool cap on a Settings page ([c8dfafa](https://github.com/cubicecho/ai-router/commit/c8dfafa95c9c52a6b4a36a5c07a2c648995b8cb0))
* **tools:** reach servers over SSE, and add HTTP servers with secret headers ([204c6a0](https://github.com/cubicecho/ai-router/commit/204c6a00e7c27e5b2cb51806dc06b3df110a71df))
* **web:** add HTTP servers as their own choice, with headers and SSE ([b6bd7a0](https://github.com/cubicecho/ai-router/commit/b6bd7a0a625773249e81729f8095913707b77828))
* **web:** show a run's input first, and runs and timelines in cards ([61c6e73](https://github.com/cubicecho/ai-router/commit/61c6e7345e7a775ace43c77f3d99740e79069565))

## [0.5.1](https://github.com/cubicecho/ai-router/compare/v0.5.0...v0.5.1) (2026-11-19)

### Bug Fixes

* **web:** pages use the page column, so the body is inset under the title ([fbda9bf](https://github.com/cubicecho/ai-router/commit/fbda9bf7a88657d6b2051554a006a19fd1a4b26f)), closes [cubicecho/cubeui#542](https://github.com/cubicecho/cubeui/issues/542)

# [0.5.0](https://github.com/cubicecho/ai-router/compare/v0.4.0...v0.5.0) (2026-11-19)

### Bug Fixes

* **web:** the first Refresh of a provider's models asks the provider again ([1a80f56](https://github.com/cubicecho/ai-router/commit/1a80f569f8ffb97abe4d144f7cd12bf338e6ce4a))

### Features

* **web:** provider, pool and MCP server pages open in tabs, full width ([c4af8a9](https://github.com/cubicecho/ai-router/commit/c4af8a9d1cf28c0cd68de2b2afbb84cc5ff789f9))
* **web:** runs are list rows, and the run page has Timeline, Details and Raw events tabs ([0719ae0](https://github.com/cubicecho/ai-router/commit/0719ae09c1c43a82d2a2f17e0cdc8ef99b86fc9d))
* **web:** Servers is MCP Servers, at /mcp-servers, and the cubeui tabs are installed ([1c2429a](https://github.com/cubicecho/ai-router/commit/1c2429aa9d665a19018ad95d0de5e75c156ea8e2))
* **web:** tabSearch keeps a detail page's open tab in the address bar ([fa8cbf9](https://github.com/cubicecho/ai-router/commit/fa8cbf98588ac5423c90d590267edfe746798ad5))
* **web:** the agent editor is a form, with the JSON a switch away ([78d753a](https://github.com/cubicecho/ai-router/commit/78d753a14b54c8d9fe74c4b99ae789ee87bdd98c))
* **web:** the agent page has Overview, Drafts, History, Workspaces, Runs and Usage tabs ([c9937db](https://github.com/cubicecho/ai-router/commit/c9937dbe0bfc316163ff3399440f2f17cc6e92df))
* **web:** the providers, pools and MCP Servers lists run full width ([54fc74d](https://github.com/cubicecho/ai-router/commit/54fc74d1aa1332a7668bfe1bc0a328a4f309de7b))
* **web:** the workspace page is tabbed, Agents, Keys, MCP and Usage, at full width ([41630ec](https://github.com/cubicecho/ai-router/commit/41630ec11ceed4eebcdc12fa270b58557b57c7a6))
* **web:** the workspaces and users lists run full width, with counts on each row ([48051db](https://github.com/cubicecho/ai-router/commit/48051db46f1abfa875a638a9628f704b0583353d))

# [0.4.0](https://github.com/cubicecho/ai-router/compare/v0.3.0...v0.4.0) (2026-11-18)

### Features

* **agents:** agent-core 6, whose run events name an exchange where they said step ([2fac95e](https://github.com/cubicecho/ai-router/commit/2fac95e8265430a4904f53901c617a9c9d0416e0))

# [0.3.0](https://github.com/cubicecho/ai-router/compare/v0.2.0...v0.3.0) (2026-11-18)

### Bug Fixes

* **admin:** a run reaches only its own workspace's instances of a server ([3f0d6a6](https://github.com/cubicecho/ai-router/commit/3f0d6a6e7b88e8813d728a888345e2ee9aa10da2))

### Features

* **admin:** the admin server ai-router, connected in process ([d847b25](https://github.com/cubicecho/ai-router/commit/d847b25749d75f9db0b43e6df4f2164cb49fa1f6))
* **agents:** drafts from agent runs, discarding them, and auto-promote ([3bbd463](https://github.com/cubicecho/ai-router/commit/3bbd463501b3021c795f43b5c036e851566ab344))
* **db:** admin-server roles on server entries, and who saved a revision ([ee0f1db](https://github.com/cubicecho/ai-router/commit/ee0f1db3cb08edb499c3c5be8a71da356f1e5852))
* **graphql:** permissions read from casl abilities, with roles for agent runs ([2a3e410](https://github.com/cubicecho/ai-router/commit/2a3e4109c99975283e8c34d6ee98860a490db968))
* **tools:** the admin server's row, with a built-in transport, and roles on its entries ([5b40946](https://github.com/cubicecho/ai-router/commit/5b40946422e59901a90b03d152779b8e6bb4acfb))
* **web:** the admin server marked built in, and roles on its workspace entries ([6a5a8ca](https://github.com/cubicecho/ai-router/commit/6a5a8ca92290d23dfc1d5fee591863a1ca16e09f))

# [0.2.0](https://github.com/cubicecho/ai-router/compare/v0.1.2...v0.2.0) (2026-11-18)

### Features

* **models:** a pool sends a call on when its target can't be reached ([804bf67](https://github.com/cubicecho/ai-router/commit/804bf67845798d147b7972cddcd8e03199a460b3))

# [0.2.0](https://github.com/cubicecho/ai-router/compare/v0.1.2...v0.2.0) (2026-11-18)

### Features

* **models:** a pool sends a call on when its target can't be reached ([804bf67](https://github.com/cubicecho/ai-router/commit/804bf67845798d147b7972cddcd8e03199a460b3))

## [0.1.2](https://github.com/cubicecho/ai-router/compare/v0.1.1...v0.1.2) (2026-11-18)

### Bug Fixes

* **tools:** starting a server login sends the server's header secrets ([073226f](https://github.com/cubicecho/ai-router/commit/073226f2604dd3317ed171d1f28b7e62b02b3b4e))

## [0.1.1](https://github.com/cubicecho/ai-router/compare/v0.1.0...v0.1.1) (2026-11-18)

### Bug Fixes

* **auth:** only failed sign-ins count against the limit ([a31dd61](https://github.com/cubicecho/ai-router/commit/a31dd61bc87da819807686f0613261d0e8f944e0))

# [0.1.0](https://github.com/cubicecho/ai-router/compare/v0.0.0...v0.1.0) (2026-11-18)

* feat!: run on Postgres only; PGlite is for the tests ([b2f1985](https://github.com/cubicecho/ai-router/commit/b2f1985c61754138f1d0b6eeb6f1d79a1ce0315d))

### Bug Fixes

* **agents:** let the default policy take llama.cpp's repeat_penalty ([779d83f](https://github.com/cubicecho/ai-router/commit/779d83fa92e3e792c1323d1dff550cf0959b6c76))
* **models:** free a pool slot when the caller gives up without reading the answer ([8f1992c](https://github.com/cubicecho/ai-router/commit/8f1992c513b888d01bfd803e07704c4da42b29fd))
* **models:** no break-off warning when the caller cancels with a read waiting ([8f67b68](https://github.com/cubicecho/ai-router/commit/8f67b6874d8b168500a553d07f4c3287f2186aa5))
* **usage:** write counts and calls whose provider, server or workspace was deleted before the write ([e55dfa0](https://github.com/cubicecho/ai-router/commit/e55dfa0cee22dbf7ddfcce6c993e9731aa8e7655))
* **web:** the pools page loads again, and a pool's targets load whole ([771975d](https://github.com/cubicecho/ai-router/commit/771975df0c263f32777840db2abc5d50663c8fb5))

### Features

* **agents:** a run with an Idempotency-Key outlives its connection ([a77c6a3](https://github.com/cubicecho/ai-router/commit/a77c6a3c79df344dbe4051bec742b625a5355944))
* **agents:** agents, revisions and rollback, warnings, and the default override policy ([0494e2b](https://github.com/cubicecho/ai-router/commit/0494e2b258a20810372acd2ab0c3fe336bf6a96c))
* **agents:** app tools, handed back and resumed as the same run ([8dcfffc](https://github.com/cubicecho/ai-router/commit/8dcfffc684baac00a257de915a445693921dc8d8))
* **agents:** conversations, named by X-Conversation-Id ([df88cac](https://github.com/cubicecho/ai-router/commit/df88caccc20d8eb024498610eb0b415c0ec688f7))
* **agents:** progress events in the answer, with ai_router.progress ([24ffac5](https://github.com/cubicecho/ai-router/commit/24ffac56cd4127dfea4d0fdd61d1838aa80593e3))
* **agents:** run agents on the agents endpoint /v1 ([cfe14d7](https://github.com/cubicecho/ai-router/commit/cfe14d7ad64e514ffab9b308855fbdb9e5dc7713)), closes [agent-core#224](https://github.com/agent-core/issues/224)
* **agents:** store run events, and serve run records at /runs ([8aa42eb](https://github.com/cubicecho/ai-router/commit/8aa42eb3cd3ceda0662b274b87df0e6c70fd5855))
* attribute tool and model calls to the agent run that made them ([8f8eb04](https://github.com/cubicecho/ai-router/commit/8f8eb04ffe2225202284fe56003a71ff6d25ad8b))
* **models:** providers, pools and forwarding, for agent runs ([6851022](https://github.com/cubicecho/ai-router/commit/6851022dba4d80fb7fb9cf7a0aec1507edec91e2)), closes [agent-core#224](https://github.com/agent-core/issues/224)
* one name rule for every router name, as the old routers have it ([bffb991](https://github.com/cubicecho/ai-router/commit/bffb99106311471616a8a97fe777ceb30c7993c3))
* scaffold the router's server: database, sign-in, roles, workspaces and keys ([af95cb0](https://github.com/cubicecho/ai-router/commit/af95cb0eabd94e545a0cd1d82afe48dca4ba86de))
* **tools:** MCP servers, installs, instances and server login, for agent runs ([17c5621](https://github.com/cubicecho/ai-router/commit/17c5621b5c114a2f070c46141d05391f53ddfd35))
* **tools:** shared groups for mounted folders, and a user id per workspace instance ([ff02ce7](https://github.com/cubicecho/ai-router/commit/ff02ce7174494af76e9d3651c18437094ad72a22))
* **tools:** the shapes a server is stored and run with, and the MCP SDK ([6d75e79](https://github.com/cubicecho/ai-router/commit/6d75e79923c2b196b992cce623217fe64cbc2579))
* **web:** agents, their history, and which agents a workspace offers ([7e2d2ec](https://github.com/cubicecho/ai-router/commit/7e2d2ec5b73b49d05dd8f2d176a58780a3c24cc5))
* **web:** providers, pools and usage pages ([773019b](https://github.com/cubicecho/ai-router/commit/773019bcf645e6926dbab43c992100170f0d520c))
* **web:** runs pages ([a8062d7](https://github.com/cubicecho/ai-router/commit/a8062d7ecc06e04fb2f7493be660e7fd7da3cb7b))
* **web:** servers, registries, server entries and activity pages ([cd91168](https://github.com/cubicecho/ai-router/commit/cd9116800cbf723c12b0e51e084ad920ce223e2b))
* **web:** the UI shell: sign-in, workspaces and their keys, users ([9d4ba4c](https://github.com/cubicecho/ai-router/commit/9d4ba4c7c19030a4f42f505e62a20ee295d328e5))
* **web:** waiting and expired runs, and stored events on the run page ([adfe8ca](https://github.com/cubicecho/ai-router/commit/adfe8caa8c6e023b391ad235a047f14bcdd2519f))

### BREAKING CHANGES

* a router that ran on PGlite under DATA_DIR no longer
  starts. Nothing has been released yet.
