#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
docker compose -f docker-compose.yml -f docker-compose.cloudwatch.yml ps
printf '\nHealth:\n'; curl -fsS http://localhost/health || true
printf '\n\nStats:\n'; curl -fsS http://localhost/stats || true; printf '\n'
