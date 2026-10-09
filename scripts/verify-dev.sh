#!/usr/bin/env bash
# Non-destructive verification: service health, readiness, internal dependency reachability,
# exposed ports, backend + frontend automated tests. Exits non-zero on any failure.
set -Eeuo pipefail

PROJECT="${COMPOSE_PROJECT:-agentic-sdlc-dev}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
set -a; [ -f .env ] && . ./.env; set +a
WEB_PORT="${WEB_PORT:-3000}"
WEB_HOST="${VERIFY_WEB_HOST:-127.0.0.1}"
SKIP_TESTS="${SKIP_TESTS:-0}"

failures=0
pass() { printf '[PASS] %s\n' "$*"; }
fail() { printf '[FAIL] %s\n' "$*"; failures=$((failures + 1)); }
dc() { docker compose -p "$PROJECT" "$@"; }

echo "==> Gate A: service health"
dc ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}\t{{.Ports}}'
for svc in postgres redis rabbitmq api orchestrator worker sandbox web; do
  ids=$(dc ps -q "$svc" || true)
  if [ -z "$ids" ]; then fail "$svc: not running"; continue; fi
  for id in $ids; do
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")
    if [ "$health" = "healthy" ]; then pass "$svc ($id): healthy"; else fail "$svc ($id): $health"; fi
  done
done
migrate_exit=$(docker inspect -f '{{.State.ExitCode}}' "$(dc ps -aq migrate | head -n1)" 2>/dev/null || echo missing)
[ "$migrate_exit" = "0" ] && pass "migrate job exited 0" || fail "migrate job exit: $migrate_exit"
revision=$(dc exec -T postgres psql -U "${POSTGRES_USER:-agentic}" -d "${POSTGRES_DB:-agentic}" -tAc 'select version_num from alembic_version' 2>/dev/null | tr -d '[:space:]' || true)
[ -n "$revision" ] && pass "schema at alembic revision $revision" || fail "alembic_version not found"

ready=$(curl -fsS --max-time 10 "http://${WEB_HOST}:${WEB_PORT}/api/ready" || true)
if echo "$ready" | grep -q '"status":"ready"'; then pass "readiness via web: $ready"; else fail "readiness via web: ${ready:-no response}"; fi
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://${WEB_HOST}:${WEB_PORT}/" || true)
[ "$code" = "200" ] && pass "web UI HTTP 200" || fail "web UI HTTP $code"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://${WEB_HOST}:${WEB_PORT}/api/workflows" || true)
[ "$code" = "401" ] && pass "API requires authentication (401)" || fail "unauthenticated API returned $code"

if dc exec -T worker python -c "import urllib.request; urllib.request.urlopen('http://sandbox:8100/health', timeout=5)" >/dev/null 2>&1; then
  pass "worker -> sandbox reachable"; else fail "worker cannot reach sandbox"; fi
if dc exec -T sandbox python -c "import socket; socket.create_connection(('postgres', 5432), timeout=3)" >/dev/null 2>&1; then
  fail "sandbox can reach postgres (isolation broken)"; else pass "sandbox isolated from postgres"; fi
if dc exec -T sandbox python -c "import urllib.request; urllib.request.urlopen('https://pypi.org', timeout=5)" >/dev/null 2>&1; then
  fail "sandbox has Internet access"; else pass "sandbox has no Internet access"; fi

echo "==> Exposure review: published ports"
published=$(docker ps --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Names}} {{.Ports}}' | grep -- '->' || true)
echo "$published"
if echo "$published" | grep -vq -- "-web-"; then fail "a non-web service publishes a port"; else pass "only web publishes a port"; fi

if [ "$SKIP_TESTS" != "1" ]; then
  echo "==> Gate B: backend tests (pytest, isolated *_test database)"
  if dc run --rm --no-deps -T api pytest -q -p no:logging; then pass "backend tests"; else fail "backend tests"; fi
  echo "==> Gate B: frontend tests (vitest, in a node build container)"
  if docker run --rm -v "$ROOT/frontend:/src:ro" -w /work node:24.10.0-alpine sh -c \
      'cp -r /src/. /work && npm ci --no-audit --no-fund --loglevel=error && npm test' ; then
    pass "frontend tests"; else fail "frontend tests"; fi
fi

echo "==> verify-dev: $failures failure(s)"
exit $(( failures > 0 ? 1 : 0 ))
