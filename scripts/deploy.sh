#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
if [[ -f .env ]]; then set -a; source .env; set +a; fi
API_REPLICAS="${API_REPLICAS:-2}"; WORKER_REPLICAS="${WORKER_REPLICAS:-1}"
./scripts/create-log-groups.sh
docker compose -f docker-compose.yml -f docker-compose.cloudwatch.yml build
docker compose -f docker-compose.yml -f docker-compose.cloudwatch.yml up -d --scale api="$API_REPLICAS" --scale worker="$WORKER_REPLICAS"
echo "Deployment complete. Health: curl http://localhost/health"
