#!/usr/bin/env bash
# Executable founder acceptance smoke for Caretaker Relay.
# Spec: caretaker-relay/docs/FOUNDER_MANUAL_VALIDATION.md
# Harness: tests/unit/care/founder-e2e-smoke.test.ts
#
# Orchestration contract (finite — never waits for server process exit):
#   DB ensure → (optional) START detached services → HEALTH timeout →
#   RUN vitest (in-process inject; no hang on API/Vite exit) → STOP unless LEAVE_SERVICES=1
#
# Requires: Colima/Docker, cr-local-pg healthy on 5434.
# Does NOT push, deploy, or touch Otzar / original niov-foundation.
#
# Env:
#   START_HTTP_SERVICES=0|1   default 0 — founder smoke uses Fastify inject (no :3100/:5180)
#   LEAVE_SERVICES=0|1        default 0 — if 1, leave detached services after run

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}"
export DATABASE_URL="${DATABASE_URL:-postgresql://caretaker:caretaker_local_only@localhost:5434/caretaker_relay_dev?schema=public}"
export DIRECT_URL="${DIRECT_URL:-$DATABASE_URL}"
export JWT_SECRET="${JWT_SECRET:-cr-local-dev-jwt-secret-not-for-production-32b}"
export CARE_STORE_BACKEND=prisma
export CARE_UNDERSTAND_MODE="${CARE_UNDERSTAND_MODE:-fixture}"
START_HTTP_SERVICES="${START_HTTP_SERVICES:-0}"
LEAVE_SERVICES="${LEAVE_SERVICES:-0}"

cleanup_http() {
  if [[ "$START_HTTP_SERVICES" == "1" && "$LEAVE_SERVICES" != "1" ]]; then
    echo "Stopping HTTP services started by this run..."
    ./scripts/care-dev-services.sh stop || true
  fi
}
trap cleanup_http EXIT

echo "=== Caretaker Relay founder E2E smoke ==="
echo "DATABASE_URL=$(echo "$DATABASE_URL" | sed -E 's#://[^:]+:[^@]+@#://***:***@#')"
echo "START_HTTP_SERVICES=$START_HTTP_SERVICES LEAVE_SERVICES=$LEAVE_SERVICES"

if ! docker exec cr-local-pg pg_isready -U caretaker -d caretaker_relay_dev >/dev/null 2>&1; then
  echo "Starting local postgres (docker-compose.local.yml)..."
  docker compose -f docker-compose.local.yml up -d postgres
  for i in $(seq 1 30); do
    if docker exec cr-local-pg pg_isready -U caretaker -d caretaker_relay_dev >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi

docker exec cr-local-pg pg_isready -U caretaker -d caretaker_relay_dev

if [[ "$START_HTTP_SERVICES" == "1" ]]; then
  echo "Starting detached Care API + Vite (health-gated, parent does not wait on exit)..."
  ./scripts/care-dev-services.sh start
fi

echo "Running vitest founder harness (finite; uses in-process inject)..."
npx vitest --config vitest.unit.config.ts --run tests/unit/care/founder-e2e-smoke.test.ts

echo ""
echo "Evidence: docs/caretaker-relay/evidence/e2e-smoke/"
echo "Results:  ../caretaker-relay/docs/FOUNDER_MANUAL_VALIDATION_RESULTS.md"
if [[ "$LEAVE_SERVICES" == "1" ]]; then
  echo "LEAVE_SERVICES=1 — HTTP services left detached under .care-dev-run/"
  ./scripts/care-dev-services.sh status || true
fi
echo "=== done (finite harness exited; not waiting on servers) ==="
