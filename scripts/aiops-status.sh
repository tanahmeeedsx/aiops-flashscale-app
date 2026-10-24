#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost}"
curl -fsS "${BASE_URL}/aiops/status" | jq .
