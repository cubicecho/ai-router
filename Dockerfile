# syntax=docker/dockerfile:1

# The one binary in the image with a capability: it switches into the child uid range and nowhere else.
FROM debian:trixie-slim AS helper
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
COPY docker/run-as-child.c /src/run-as-child.c
RUN gcc -O2 -Wall -Wextra -Werror -o /run-as-child /src/run-as-child.c

FROM node:26-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Codegen and the UI bundle. The server isn't compiled: its sources are the build output.
RUN npm run build

# Optional: docker build --target test
FROM builder AS test
CMD ["npm", "test"]

FROM node:26-slim AS runtime
WORKDIR /app

# setcap is needed only while building this layer.
COPY --from=helper /run-as-child /usr/local/bin/run-as-child
RUN apt-get update && apt-get install -y --no-install-recommends libcap2-bin \
 && chown root:node /usr/local/bin/run-as-child \
 && chmod 0750 /usr/local/bin/run-as-child \
 && setcap cap_setuid,cap_setgid+ep /usr/local/bin/run-as-child \
 && apt-get purge -y libcap2-bin && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# uv and uvx, for servers from PyPI: `uvx <package>` fetches and runs one at start, as the server's own
# user, with uv's cache and Python in that server's folder. Pinned to an exact release.
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /uvx /usr/local/bin/

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server server
COPY drizzle drizzle
# So an operator, and CI, can check child isolation on their own host.
COPY scripts/check-children.sh scripts/check-children.sh
COPY --from=builder /app/dist dist

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
# What the router writes besides Postgres: the MCP servers' folders. Set up before VOLUME, so a new
# volume starts that way. /data is owned by node, and everyone else may only pass through it to
# servers/, never list it. servers/ is 1733: a server, running as its own uid, may create its own
# folder there, but can't list the others or delete one it doesn't own. Each folder is 0700, so no
# other server can read it either.
RUN mkdir -p /data/servers && chown node:node /data /data/servers && chmod 0711 /data && chmod 1733 /data/servers
VOLUME /data
EXPOSE 3000
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so node is PID 1 and gets SIGTERM itself.
CMD ["node", "server/index.ts"]
