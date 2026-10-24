#!/usr/bin/env bash
set -euo pipefail

SCENARIO="${1:-latency}"
BASE_URL="${BASE_URL:-http://localhost}"
VUS="${VUS:-100}"
DURATION="${DURATION:-3m}"

case "$SCENARIO" in
  latency|error-spike|worker-bottleneck|queue-backlog|log-anomaly|normal) ;;
  *)
    echo "Unknown scenario: $SCENARIO"
    echo "Valid: latency, error-spike, worker-bottleneck, queue-backlog, log-anomaly, normal"
    exit 1
    ;;
esac

echo "Activating AIOps scenario: ${SCENARIO}"
curl -fsS -X POST "${BASE_URL}/aiops/scenarios/${SCENARIO}" | jq .

if [[ "$SCENARIO" == "normal" ]]; then
  exit 0
fi

echo "Running local smoke load: VUS=${VUS} DURATION=${DURATION}"
VUS="$VUS" DURATION="$DURATION" ./scripts/run-small-local-load.sh

echo
echo "Scenario completed. Watch CloudWatch dashboard and alarms."
echo "Reset when done: ./scripts/aiops-reset.sh"
