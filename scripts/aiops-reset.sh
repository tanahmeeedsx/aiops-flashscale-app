#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${BASE_URL:-http://localhost}"
curl -fsS -X POST "${BASE_URL}/aiops/scenarios/normal" | jq .
echo "AIOps mode reset to normal."
