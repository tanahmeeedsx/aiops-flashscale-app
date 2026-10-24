#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PROJECT_NAME="${PROJECT_NAME:-flashscale-dlt}"
AWS_REGION="${AWS_REGION:-us-west-2}"
MINUTES="${MINUTES:-30}"
START_TIME=$(( $(date +%s) - MINUTES * 60 ))
END_TIME=$(date +%s)

QUERY='fields @timestamp, source, event_type, scenario, message, status_code, latency_ms, delay_ms, queue_depth
| filter event_type like /aiops/ or status_code >= 500 or message like /error|timeout|bottleneck|anomaly/
| sort @timestamp desc
| limit 50'

QUERY_ID="$(aws logs start-query \
  --log-group-names "/${PROJECT_NAME}/api" "/${PROJECT_NAME}/worker" \
  --start-time "$START_TIME" \
  --end-time "$END_TIME" \
  --query-string "$QUERY" \
  --query queryId \
  --output text \
  --region "$AWS_REGION")"

echo "Started CloudWatch Logs Insights query: ${QUERY_ID}"
sleep 3
aws logs get-query-results \
  --query-id "$QUERY_ID" \
  --region "$AWS_REGION" \
  --output table
