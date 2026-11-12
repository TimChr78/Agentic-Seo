# Docker Compose deployment

The stack is two containers: the app (`ghcr.io/timchr78/agentic-seo`, one image for every role,
ADR-0002) and Postgres 17. Object storage is a named volume for the local filesystem driver; the
optional renderer sidecar arrives in a later phase and is not part of this stack (ADR-0003).

There is no release bundle yet: Phase 0 builds the image from a checkout. The release page will
carry a `agentic-seo-compose-<version>.tar.gz` with `docker-compose.yml`, `.env.example`,
`compose.override.example.yaml` and the changelog, and this page will lead with that.

## Install from a checkout

```bash
git clone https://github.com/TimChr78/Agentic-Seo.git && cd Agentic-Seo
corepack pnpm install
corepack pnpm cli init        # writes .env with fresh secrets, mode 600, never printed
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
docker compose exec app aseo bootstrap --email you@example.com --workspace 'My site'
docker compose exec app aseo doctor
```

The admin UI and the REST API are then on `http://localhost:3000`. `aseo init` generates
`POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `AUTH_SECRET` and `MASTER_KEY` and asks for `PUBLIC_URL`.
`aseo bootstrap` reads the password from `ASEO_BOOTSTRAP_PASSWORD`, a hidden prompt, or stdin.

`docker-compose.yml` is the release file: it pulls `ghcr.io/timchr78/agentic-seo:${ASEO_VERSION}`.
`docker-compose.build.yml` is an overlay for a source checkout: it builds this tree and tags it
`agentic-seo:local`. Always pass both `-f` flags when building locally, and neither when the image
is published.

By hand, generate the two passwords as **hex** (`openssl rand -hex 32`) and the two keys as base64
(`openssl rand -base64 32`). Compose substitutes `POSTGRES_PASSWORD` into `DATABASE_URL` verbatim
and cannot percent-encode it, so a base64 password that contains `/` makes the URL invalid: the app
then stops with `Configuration is incomplete: DATABASE_URL is not a valid URL` instead of a stack
trace. If a password must stay as it is, percent-encode the reserved character in `DATABASE_URL`
yourself (`/` as `%2F`) and set that `DATABASE_URL` for the `app` service in `compose.override.yaml`.

`ASEO_VERSION` pins the released image so a restart or pull does not silently change versions;
`ASEO_PORT` is the published host port (the app still listens on 3000 inside the container). If you
change `ASEO_PORT`, change `PUBLIC_URL` with it, because the UI and the sign-in origin use it.

## Environment variables

Every variable in `apps/server/src/config.ts` is passed into the `app` container, including
`METRICS_TOKEN`, `KEY_PROVIDER` with the OpenBao/AWS KMS settings and the worker limits. Uncomment
or append an entry in `.env` and run `docker compose up -d`; Compose recreates the container when
the environment changes. `.env.example` documents every key with its default, so an unset (or
empty) value still applies that default.

Compose supplies `DATABASE_URL`, `ROLE=all` and `PORT=3000` itself. They are documented in
`.env.example` for other deployments; changing them in the Compose `.env` does not move the stack
to another database. `ROLE` is the one exception: set it only to split the roles across containers
(`ROLE=api`, `ROLE=worker`, `ROLE=scheduler`).

MCP needs an HTTPS `PUBLIC_URL`. On plain HTTP other than loopback the admin UI and REST API still
work, but the MCP/OAuth client endpoints stay off; `aseo doctor` reports this as a warning.

## Never edit docker-compose.yml

Treat `docker-compose.yml` as read-only. Compose reads `compose.override.yaml` from the same
directory automatically, so site-specific changes go there:

```bash
cp compose.override.example.yaml compose.override.yaml
```

The example has commented blocks for a tunnel on another Docker network, bind mounts instead of the
named volumes, proxy settings, a loopback-only port mapping and resource limits. Uncomment the block
you need. Upgrading then means replacing `docker-compose.yml` with the new release's copy and
bumping `ASEO_VERSION`; your override is untouched.

## Storage

`pgdata` holds Postgres. `appdata` is mounted at `/data` in the app and is where the local
filesystem blob driver will keep page snapshots, screenshots and reports (ADR-0003); Phase 0 has no
storage module yet, so it stays empty. The filesystem driver is for single-node installs: more than
one app node will need S3-compatible storage, which will be configuration rather than a volume.

## Restarts and health

Both services use `restart: unless-stopped`, so the stack comes back after a host reboot or a
Docker daemon restart. The app waits for Postgres to report healthy, then migrates before it serves
(`SKIP_MIGRATIONS` stays `false`; Kubernetes runs migrations as a separate job instead).

The image's healthcheck probes `/readyz` (which pings Postgres) every 15 s and ignores the first
60 s, so a first migration does not count as a failed probe. On a large install an upgrade can take
longer than that: start it with `docker compose up -d` rather than `docker compose up --wait` when
you expect slow migrations, then follow `docker compose ps` and `docker compose logs -f app` until
the container is healthy.

## Upgrading

```bash
git pull                                # while releases are built from a checkout
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
docker compose exec app aseo doctor
```

The app runs migrations at start-up. Take a backup first (see below). With a release image instead,
change `ASEO_VERSION` in `.env`, run `docker compose pull` and then `docker compose up -d`.

## Backups

`pg_dump` lives in the Postgres container, so no client is installed in the app image:

```bash
docker compose exec -T postgres pg_dump -U aseo -d aseo -Fc > aseo-$(date +%F).dump
```

Restore into a new stack before serving traffic:

```bash
docker compose down
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U aseo -d aseo --clean --if-exists < aseo-2026-01-01.dump
docker compose up -d
```

A dump holds the encrypted secrets, so keep `MASTER_KEY` (or the OpenBao/AWS KMS key) with your
backups: without it the stored provider credentials cannot be read. `appdata` needs a backup of its
own once storage lands; today it is empty.

## Smoke test

`scripts/smoke.sh` does what this page describes, from scratch: it builds the image, starts
Postgres and the app, runs `aseo migrate`, `aseo bootstrap` and `aseo doctor`, then checks
`/healthz`, `/readyz`, `/openapi.json` and the UI, signs in over REST, creates an API token and
calls `/v1/whoami`. It uses `docker compose` when the plugin is installed and plain `docker run` on
a user-defined network otherwise, and it removes everything it created. CI runs it on every pull
request.
