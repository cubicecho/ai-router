# Spikes

Phase 0 experiments, kept for their results. Not part of the build.

- `resolve-personal-finance/`: Personal Finance resolved through `agent-core`'s real
  `parseSpec` and `resolveAgentSpec`, with the layers ai-router builds. Run with
  `node resolve-personal-finance.ts` from a checkout where `../agent-core` exists. Its seven
  cases seed phase 6's tests.
- `child-user/`: running MCP children as other users while the router is `USER node`.
  `run-as-child.c` is the helper phase 1 builds into the image. Try it with
  `docker build -f Dockerfile.helper -t child-spike .`, then
  `docker run --rm child-spike /usr/local/bin/run-as-child 10001 id`.
