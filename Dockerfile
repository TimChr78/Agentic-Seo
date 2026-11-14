# One image for every role (ADR-0002). Select roles with ROLE=api,worker,scheduler (default: all).
# The renderer sidecar of overview.md §2 is a separate image in Phase 2 and is not built here.
# Pinned by digest so a rebuild of one commit gives the same runtime; bump it deliberately.
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NODE_ENV=production COREPACK_HOME=/corepack
WORKDIR /app
# pnpm (the version pinned in package.json) is part of the image, so a container never downloads it.
COPY package.json ./
RUN corepack enable && corepack install && chmod -R a+rX /corepack

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages ./packages
COPY apps/server ./apps/server
# The server and the packages it uses, with their production dependencies only: the server runs
# TypeScript through tsx (a production dependency), so its sources ship, but Vite, Biome and the
# typechecker do not. apps/web stays out of this stage so its packages are not resolved here.
RUN pnpm install --frozen-lockfile --prod --filter "@agentic-seo/server..."

# The admin UI: a production build of `apps/web`, served by the server from /app/apps/web/dist.
FROM base AS web
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web
# Vite and TypeScript are dev dependencies, and base sets NODE_ENV=production.
RUN pnpm install --frozen-lockfile --prod=false --filter "@agentic-seo/web..."
RUN pnpm --filter @agentic-seo/web build

FROM base
# The commit this image was built from, reported as `commit` by /healthz and /readyz.
ARG GIT_SHA
ENV ASEO_GIT_SHA=$GIT_SHA
COPY --from=deps /app /app
COPY --from=web /app/apps/web/dist /app/apps/web/dist
# `aseo init` reads the template from the image root, even when the working directory is a mount.
COPY .env.example /app/.env.example
# `aseo` is the admin CLI without pnpm's script banner (which would echo arguments such as secrets).
# It calls pnpm's entry point in corepack's installed copy directly: the `pnpm` shim resolves the
# pinned version from the working directory, which `docker run -w /work … aseo init` does not have,
# and then it wants to download and cache one (as a user that cannot write /corepack).
# --dir lets that work: pnpm leaves INIT_CWD pointing at /work, so init writes .env there.
# The `--` keeps pnpm from eating the CLI's flags: without it `aseo doctor --env-file X` passes
# --env-file to node, which fails with "node: X: not found".
RUN pnpm_bin=$(find /corepack/v1/pnpm -maxdepth 3 -name pnpm.cjs | head -n 1) \
 && test -n "$pnpm_bin" \
 && printf '#!/bin/sh\nexec node %s --dir /app --silent --filter @agentic-seo/server cli -- "$@"\n' "$pnpm_bin" > /usr/local/bin/aseo \
 && chmod +x /usr/local/bin/aseo
# The named `appdata` volume in docker-compose.yml inherits this directory's owner (node, uid 1000).
# It is where the local filesystem blob driver (ADR-0003) writes snapshots and reports; Phase 0 has
# no storage module yet, so nothing reads it.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
# Only the api role listens on HTTP (apps/server/src/main.ts). A worker-only or scheduler-only
# container has no /readyz, so it is healthy while its process runs: Docker's restart policy
# covers a process that exits.
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s \
  CMD ["node", "-e", "const roles = (process.env.ROLE || 'all').split(',').map((r) => r.trim()); if (!roles.includes('all') && !roles.includes('api')) process.exit(0); fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/readyz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
# `docker run … aseo <cmd>` works because `aseo` is on PATH; the default command serves all roles.
CMD ["pnpm", "--filter", "@agentic-seo/server", "start"]
