#!/usr/bin/env bash
# Build, migrate and start the development stack with Docker Compose.
#   DEPLOY_UPDATE=1 DEPLOY_REF=main ./scripts/deploy-dev.sh   # also fast-forward the checkout
# Never resets the working tree, never deletes volumes, never overwrites .env.
set -Eeuo pipefail

PROJECT="${COMPOSE_PROJECT:-agentic-sdlc-dev}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_UPDATE="${DEPLOY_UPDATE:-0}"
DEPLOY_REF="${DEPLOY_REF:-}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-300}"
cd "$ROOT"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }
trap 'die "deployment failed at line $LINENO (exit $?)" 1' ERR

log "Preflight"
command -v docker >/dev/null || die "docker not installed" 2
docker compose version >/dev/null || die "docker compose plugin missing" 2
command -v git >/dev/null || die "git not installed" 2
[ -f .env ] || die ".env missing: cp .env.example .env && chmod 600 .env, then set real values" 3
if grep -Eq '^(POSTGRES_PASSWORD|RABBITMQ_PASSWORD|JWT_SECRET|SANDBOX_TOKEN|ADMIN_PASSWORD)=change-me' .env; then
  die ".env still contains change-me placeholders" 3
fi
perms=$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env)
[ "$perms" = "600" ] || { echo "tightening .env permissions ($perms -> 600)"; chmod 600 .env; }
git check-ignore -q .env || die ".env is not git-ignored" 3
avail_kb=$(df -Pk . | awk 'NR==2 {print $4}')
[ "$avail_kb" -gt 3000000 ] || die "less than 3 GB free disk space" 4
free -h 2>/dev/null | head -2 || true

if [ "$DEPLOY_UPDATE" = "1" ]; then
  log "Updating checkout"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    die "tracked files have local changes; commit or stash them first (nothing was modified)" 5
  fi
  git fetch --prune
  if [ -n "$DEPLOY_REF" ]; then git checkout "$DEPLOY_REF"; fi
  git pull --ff-only
fi
SHA=$(git rev-parse HEAD)
echo "Deploying commit $SHA ($(git branch --show-current 2>/dev/null || echo detached))"

log "Validating Compose configuration"
docker compose -p "$PROJECT" config --quiet

log "Building images"
docker compose -p "$PROJECT" build

log "Starting infrastructure"
docker compose -p "$PROJECT" up -d --wait --wait-timeout "$HEALTH_TIMEOUT" postgres redis rabbitmq

log "Running database migrations"
docker compose -p "$PROJECT" run --rm migrate
docker compose -p "$PROJECT" exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select version_num from alembic_version"'

log "Starting application services"
docker compose -p "$PROJECT" up -d --wait --wait-timeout "$HEALTH_TIMEOUT"

log "Status"
docker compose -p "$PROJECT" ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
set -a; . ./.env; set +a
curl -fsS --max-time 10 "http://127.0.0.1:${WEB_PORT:-3000}/api/ready" && echo
echo "Deployed commit: $SHA"
echo "Web entry point: ${WEB_BIND:-127.0.0.1}:${WEB_PORT:-3000}"
