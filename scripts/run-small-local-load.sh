#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
VUS="${VUS:-25}"; DURATION="${DURATION:-2m}"; BASE_URL="${BASE_URL:-http://nginx}"; ORDER_RATIO="${ORDER_RATIO:-0.05}"
./scripts/package-dlt-k6.sh --base-url "$BASE_URL" --peak-vus "$VUS" --order-ratio "$ORDER_RATIO" --duration "$DURATION" --local-only
echo "Running small local k6 smoke test. Do not use this for 100k."
docker run --rm -i --network "${PWD##*/}_flashscale" grafana/k6:0.54.0 run - < generated/flashscale-k6-local.js
