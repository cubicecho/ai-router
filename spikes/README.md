# Spikes

Phase 0 experiments, kept for their results. Not part of the build.

- `resolve-personal-finance/`: Personal Finance resolved through `agent-core`'s real
  `parseSpec` and `resolveAgentSpec`, with the layers ai-router builds. Run with
  `node resolve-personal-finance.ts` from a checkout where `../agent-core` exists. Its seven
  cases seed phase 6's tests.
- Child users (no folder left): running MCP children as other users while the router is `USER node`.
  The helper it settled on is `docker/run-as-child.c`, built into the image, and its checks are
  `scripts/check-children.sh`, which CI runs against the real image.
