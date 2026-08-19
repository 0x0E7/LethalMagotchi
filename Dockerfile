# LethalMagotchi — global-server image (see .claude/devops.md §1)
#
# Single image, two responsibilities:
#   - default CMD serves the Fastify API + the built SPA (same-origin, via CLIENT_DIST)
#   - `node apps/server/dist/db/migrate.js` / `.../seed.js` are the release-time DB commands
#     (deliberately NOT run at container boot — see docker-compose.yml and .github/workflows/deploy.yml)
#
# Base is bookworm-slim, NOT Alpine: argon2 ships glibc prebuilds in its npm tarball,
# so both stages resolve a prebuilt .node binary and neither needs a C toolchain.
# Build and runtime stages must share the same libc for that to hold.

# ---------------------------------------------------------------------------
# Stage 1 — build: compile packages/shared -> apps/server -> apps/client
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

ENV NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app

# Manifests only first, so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/

RUN npm ci --no-audit --no-fund

# Sources.
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/client apps/client

# Root `build` script is already ordered shared -> server -> client.
# apps/server and apps/client both import packages/shared/dist, so the order matters.
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — runtime: production deps + compiled output only
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PORT=8080 \
    HOST=0.0.0.0 \
    CLIENT_DIST=/app/public

WORKDIR /app

# Same manifests -> same lockfile resolution as the build stage, minus devDependencies.
# All three workspace manifests are required: the lockfile describes the whole workspace,
# and npm needs them to recreate the node_modules/@lethalmagotchi/* symlinks.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/

RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# Compiled output. packages/shared/dist must land where the workspace symlink points.
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/server/dist apps/server/dist
# migrate.js resolves its SQL files relative to itself: apps/server/dist/db -> ../../migrations
COPY --from=build /app/apps/server/migrations apps/server/migrations
# Built SPA, served by @fastify/static when CLIENT_DIST points at it.
COPY --from=build /app/apps/client/dist public

# Files stay root-owned and world-readable; the app never writes to its own tree.
USER node

EXPOSE 8080

# Liveness only (no DB) — /readyz is what orchestrators/PaaS should poll.
# Uses global fetch so the image needs neither curl nor wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "apps/server/dist/index.js"]
