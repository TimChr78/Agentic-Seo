#!/usr/bin/env bash
# Smoke test of the Docker image as a self-hoster runs it: a fresh Postgres, `aseo migrate`,
# `aseo bootstrap`, `aseo doctor`, the health endpoints, the admin UI shell, a REST sign-in, an API
# token and `/v1/whoami`. CI runs it; run it locally with `scripts/smoke.sh`. Every run has its own
# id: its Compose project, containers, network, volume and label carry it, and cleanup removes only
# those, so two runs side by side (or a real install on the same host) never touch each other.
#
# Uses `docker compose` when the plugin is installed, and plain `docker run` on a user-defined
# network otherwise: some hosts -- including the delegate sandboxes -- ship only the Docker CLI.
# Either way the checkout's .env is never touched: secrets go in a throwaway env file.
set -euo pipefail
cd "$(dirname "$0")/.."

RUN_ID="aseo-smoke-$(openssl rand -hex 4)"
LABEL="aseo-smoke-run=$RUN_ID"
NET="$RUN_ID-net"
PG_CONTAINER="$RUN_ID-postgres"
APP_CONTAINER="$RUN_ID-app"
PG_VOLUME="$RUN_ID-pgdata"
IMAGE="${SMOKE_IMAGE:-aseo-smoke-app}"
# A free port chosen for this run, so nothing a self-hoster or a dev server holds is in the way.
# SMOKE_PORT fixes it.
PORT="${SMOKE_PORT:-$(node -e "const s=require('node:net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")}"
# Inside a container (a delegate's sandbox) the Docker daemon publishes on the host, and the host's
# bridge address is what this script can reach; on a normal host that is loopback.
in_container() { [ -f /.dockerenv ] || grep -qa docker /proc/1/cgroup 2>/dev/null; }
BIND_IP="${SMOKE_BIND_IP:-$(in_container && echo 172.17.0.1 || echo 127.0.0.1)}"
BASE="http://$BIND_IP:$PORT"
EMAIL=owner@example.com
PASSWORD='smoke-test-password-123'

# Fresh secrets every run. Passwords are hex because Compose interpolates POSTGRES_PASSWORD into
# DATABASE_URL and cannot percent-encode it; the keys are base64 because the server reads base64.
POSTGRES_PASSWORD=$(openssl rand -hex 16)
APP_DB_PASSWORD=$(openssl rand -hex 16)
AUTH_SECRET=$(openssl rand -base64 32)
MASTER_KEY=$(openssl rand -base64 32)

ENV_FILE=$(mktemp)
COOKIES=$(mktemp)
cat >"$ENV_FILE" <<ENV
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
APP_DB_PASSWORD=$APP_DB_PASSWORD
AUTH_SECRET=$AUTH_SECRET
MASTER_KEY=$MASTER_KEY
PUBLIC_URL=$BASE
ASEO_PORT=$PORT
ASEO_BIND=$BIND_IP
ASEO_BUILD_IMAGE=$IMAGE
ENV

# The same pinned Postgres the Compose file uses.
PG_IMAGE=$(sed -n 's/^ *image: *\(postgres:.*\)$/\1/p' docker-compose.yml | head -n 1)
[ -n "$PG_IMAGE" ]

COMPOSE_MODE=false
PLAIN_MODE=false

cleanup() {
  code=$?
  if [ "$code" -ne 0 ]; then
    echo "--- last 50 log lines" >&2
    if $COMPOSE_MODE; then
      dc logs --tail 50 app 2>&1 | tail -50 >&2 || true
    elif docker inspect "$APP_CONTAINER" >/dev/null 2>&1; then
      docker logs --tail 50 "$APP_CONTAINER" 2>&1 | tail -50 >&2 || true
    fi
  fi
  if $COMPOSE_MODE; then dc down -v --remove-orphans >/dev/null 2>&1 || true; fi
  # Only what this run created: the label and the names carry its id.
  if $PLAIN_MODE; then
    docker ps -aq --filter "label=$LABEL" | xargs -r docker rm -f >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    docker volume rm "$PG_VOLUME" >/dev/null 2>&1 || true
  fi
  rm -f "$ENV_FILE" "$COOKIES"
  exit "$code"
}
trap cleanup EXIT

dc() { docker compose --env-file "$ENV_FILE" -p "$RUN_ID" -f docker-compose.yml -f docker-compose.build.yml "$@"; }
use_compose() { docker compose version >/dev/null 2>&1; }

# Always build the local image: the release file pulls ghcr.io/timchr78/agentic-seo, and the
# overlay points that service at SMOKE_IMAGE instead. SMOKE_NO_BUILD=1 reuses an image built
# beforehand (CI builds it once with buildx and then runs this).
if [ -z "${SMOKE_NO_BUILD:-}" ]; then
  docker build --build-arg GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || true)" -t "$IMAGE" .
fi

if use_compose; then
  COMPOSE_MODE=true
  echo "--- starting with docker compose"
  dc up -d $([ -n "${SMOKE_NO_BUILD:-}" ] || echo --build) --wait --wait-timeout 300
  dc exec -T app aseo migrate
  dc exec -T -e ASEO_BOOTSTRAP_PASSWORD="$PASSWORD" app aseo bootstrap --email "$EMAIL" --workspace Smoke
  dc exec -T app aseo doctor
else
  PLAIN_MODE=true
  echo "--- starting with docker run (no Compose plugin)"
  docker network create --label "$LABEL" "$NET" >/dev/null
  docker run -d --name "$PG_CONTAINER" --label "$LABEL" --network "$NET" --network-alias postgres \
    -e POSTGRES_USER=aseo -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" -e POSTGRES_DB=aseo \
    -v "$PG_VOLUME":/var/lib/postgresql/data "$PG_IMAGE" >/dev/null
  for _ in $(seq 60); do
    if docker exec "$PG_CONTAINER" pg_isready -U aseo -d aseo >/dev/null 2>&1; then break; fi
    sleep 1
  done
  docker exec "$PG_CONTAINER" pg_isready -U aseo -d aseo >/dev/null

  database_url="postgres://aseo:$POSTGRES_PASSWORD@postgres:5432/aseo"
  docker run --rm --label "$LABEL" --network "$NET" --env-file "$ENV_FILE" \
    -e DATABASE_URL="$database_url" -e ROLE=all "$IMAGE" aseo migrate
  docker run -d --name "$APP_CONTAINER" --label "$LABEL" --network "$NET" \
    --env-file "$ENV_FILE" -e DATABASE_URL="$database_url" -e ROLE=all -p "$BIND_IP:$PORT:3000" "$IMAGE" >/dev/null
  for _ in $(seq 180); do
    if curl -fsS "$BASE/readyz" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  docker exec -e ASEO_BOOTSTRAP_PASSWORD="$PASSWORD" "$APP_CONTAINER" aseo bootstrap --email "$EMAIL" --workspace Smoke
  docker exec "$APP_CONTAINER" aseo doctor
fi

# The endpoints an operator, a proxy and an MCP client rely on. Each grep is the assertion: set -e
# stops the script when one does not match.
curl -fsS "$BASE/healthz" | grep -q '"ok":true'
echo "healthz ok"
curl -fsS "$BASE/readyz" | grep -q '"ok":true'
echo "readyz ok"
curl -fsS "$BASE/openapi.json" | grep -q '"openapi":"3.1.0"'
echo "openapi.json ok"
# The admin UI: the Vite build is served from the image, not a mounted volume.
curl -fsS "$BASE/" | grep -q 'id="root"'
echo "ui ok"

# A person signs in, creates an API token and uses it: the path a script or an agent takes.
curl -fsS -c "$COOKIES" -H 'content-type: application/json' -H "origin: $BASE" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$BASE/api/auth/sign-in/email" >/dev/null
echo "signed in"
TOKEN=$(curl -fsS -b "$COOKIES" -H 'content-type: application/json' -H "origin: $BASE" \
  -d '{"name":"smoke","scopes":["artifacts:read"]}' "$BASE/v1/apiTokens.create" |
  node -e "let s='';process.stdin.on('data',(c)=>{s+=c}).on('end',()=>{const t=JSON.parse(s).token;if(!t)process.exit(1);process.stdout.write(t)})")
echo "api token created"
# A token acts as an agent for its owner, in the one workspace it was created for.
curl -fsS -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' "$BASE/v1/whoami" | grep -q '"type":"agent"'
echo "whoami ok"

echo "smoke test passed"
