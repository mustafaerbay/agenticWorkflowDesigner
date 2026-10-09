#!/usr/bin/env bash
# End-to-end smoke test through the public web entry point (nginx -> API -> RabbitMQ
# -> orchestrator -> worker -> sandbox), including WebSocket streaming and DB checks.
# Uses only deterministic scripted agents (no LLM). Cleans up the workflows it creates.
set -Eeuo pipefail

PROJECT="${COMPOSE_PROJECT:-agentic-sdlc-dev}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMEOUT="${SMOKE_TIMEOUT:-180}"

cd "$ROOT"
echo "==> Running smoke workflow test (project ${PROJECT})"
docker compose -p "$PROJECT" run --rm --no-deps -T \
  -e SMOKE_BASE_URL="${SMOKE_BASE_URL:-http://web:8080}" \
  -e SMOKE_TIMEOUT="$TIMEOUT" \
  api timeout "$((TIMEOUT * 4))" python -m scripts.smoke_workflow
