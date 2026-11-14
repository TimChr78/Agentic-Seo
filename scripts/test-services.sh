#!/usr/bin/env bash
# Start, stop or describe the shared test stack (docker-compose.test.yml).
#
#   scripts/test-services.sh up | down | env | status
#
# `env` prints the variables the tests read; use it as `eval "$(scripts/test-services.sh env)"`.
# Inside a container (a delegate's sandbox), the host's published ports are reached through the
# Docker bridge, so the bind address defaults to 172.17.0.1 there.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env.test ] && set -a && . ./.env.test && set +a

in_container() { [ -f /.dockerenv ] || grep -qa docker /proc/1/cgroup 2>/dev/null; }
if [ -z "${AS_TEST_BIND_IP:-}" ] && in_container; then export AS_TEST_BIND_IP=172.17.0.1; fi
# The database has a known password, so a wildcard bind is refused rather than "fixed" for one path.
case "${AS_TEST_BIND_IP:-127.0.0.1}" in
  0.0.0.0|::|'[::]'|'*') echo "error: AS_TEST_BIND_IP=${AS_TEST_BIND_IP} would expose the test database to the network; use 127.0.0.1 or a specific interface address" >&2; exit 2 ;;
esac
export AS_TEST_BIND_IP="${AS_TEST_BIND_IP:-127.0.0.1}"
host="$AS_TEST_BIND_IP"
port="${AS_TEST_PG_PORT:-45432}"

# Without the Compose plugin (some hosts only have the Docker CLI), run the same container directly.
has_compose() { docker compose version >/dev/null 2>&1; }
bind="${AS_TEST_BIND_IP:-127.0.0.1}"
up_plain() {
  if docker inspect as-test-postgres >/dev/null 2>&1; then docker start as-test-postgres >/dev/null; else
    docker run -d --name as-test-postgres --label as-test=1 \
      -e POSTGRES_USER=aseo -e POSTGRES_PASSWORD=aseo -e POSTGRES_DB=aseo \
      -p "${bind}:${port}:5432" -v as-test-pgdata:/var/lib/postgresql/data \
      postgres:17-alpine postgres -c max_connections=300 -c fsync=off -c synchronous_commit=off >/dev/null
  fi
  for _ in $(seq 1 60); do docker exec as-test-postgres pg_isready -U aseo >/dev/null 2>&1 && return 0; sleep 1; done
  echo "error: Postgres did not become ready" >&2; return 1
}

case "${1:-}" in
  up) if has_compose; then docker compose -f docker-compose.test.yml up -d --wait; else up_plain; fi ;;
  down) if has_compose; then docker compose -f docker-compose.test.yml down -v; else docker rm -f as-test-postgres >/dev/null; docker volume rm as-test-pgdata >/dev/null; fi ;;
  status) if has_compose; then docker compose -f docker-compose.test.yml ps; else docker ps --filter label=as-test=1; fi ;;
  env) echo "export TEST_DATABASE_URL=postgres://aseo:aseo@${host}:${port}/aseo" ;;
  *) echo "usage: $0 up|down|env|status" >&2; exit 2 ;;
esac
