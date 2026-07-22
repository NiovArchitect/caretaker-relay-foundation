#!/usr/bin/env bash
# Explicit start/stop/status for Caretaker Relay dev services.
# Finite validation must NEVER block on process exit — use:
#   start → wait health → work → stop
# Or leave detached with: start (records PID under .care-dev-run/)
#
# Usage:
#   ./scripts/care-dev-services.sh start|stop|status|restart
#   LEAVE_SERVICES=1 ./scripts/care-dev-services.sh start   # keep after shell exits

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}"
export DATABASE_URL="${DATABASE_URL:-postgresql://caretaker:caretaker_local_only@localhost:5434/caretaker_relay_dev?schema=public}"
export DIRECT_URL="${DIRECT_URL:-$DATABASE_URL}"
export JWT_SECRET="${JWT_SECRET:-cr-local-dev-jwt-secret-not-for-production-32b}"
export CARE_STORE_BACKEND=prisma
export CARE_UNDERSTAND_MODE="${CARE_UNDERSTAND_MODE:-fixture}"
export PORT="${PORT:-3100}"

cmd="${1:-status}"

case "$cmd" in
  start)
    npx tsx -e "
      import {
        startCareApi,
        startViteApp,
        isPortListening,
      } from './scripts/lib/dev-service-lifecycle.ts';
      async function main() {
        if (!isPortListening(3100)) {
          const api = await startCareApi();
          console.log('care-api STARTED', { pid: api.pid, port: api.port, health: api.healthUrl });
        } else {
          console.log('care-api ALREADY_UP port 3100');
        }
        if (!isPortListening(5180)) {
          const vite = await startViteApp();
          console.log('vite-app STARTED', { pid: vite.pid, port: vite.port, health: vite.healthUrl });
        } else {
          console.log('vite-app ALREADY_UP port 5180');
        }
        console.log('DONE start (detached; parent exits without waiting for servers)');
      }
      main().catch((e) => { console.error(e); process.exit(1); });
    "
    ;;
  stop)
    npx tsx -e "
      import { stopAllCareDevServices, isPortListening } from './scripts/lib/dev-service-lifecycle.ts';
      async function main() {
        await stopAllCareDevServices();
        console.log('3100 free?', !isPortListening(3100));
        console.log('5180 free?', !isPortListening(5180));
      }
      main().catch((e) => { console.error(e); process.exit(1); });
    "
    ;;
  status)
    echo "3100: $(lsof -nP -iTCP:3100 -sTCP:LISTEN 2>/dev/null || echo FREE)"
    echo "5180: $(lsof -nP -iTCP:5180 -sTCP:LISTEN 2>/dev/null || echo FREE)"
    curl -sS --max-time 2 http://127.0.0.1:3100/api/v1/care/health 2>/dev/null || echo "API not responding"
    curl -sS -o /dev/null -w "vite_http=%{http_code}\n" --max-time 2 http://127.0.0.1:5180/ 2>/dev/null || echo "vite_http=down"
    if [[ -d .care-dev-run ]]; then
      ls -la .care-dev-run/ 2>/dev/null || true
    fi
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  *)
    echo "Usage: $0 start|stop|status|restart" >&2
    exit 2
    ;;
esac
