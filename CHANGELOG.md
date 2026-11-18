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
