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
TOPIC_NAME="${AIOPS_SNS_TOPIC_NAME:-${SNS_TOPIC_NAME:-${PROJECT_NAME}-traffic-alerts}}"

ALARMS=(
  "${PROJECT_NAME}-aiops-traffic-anomaly"
  "${PROJECT_NAME}-aiops-latency-anomaly"
  "${PROJECT_NAME}-aiops-queue-depth-anomaly"
  "${PROJECT_NAME}-aiops-5xx-error-spike"
  "${PROJECT_NAME}-aiops-nginx-5xx-error-spike"
  "${PROJECT_NAME}-aiops-queue-depth-high"
  "${PROJECT_NAME}-aiops-injected-error-observed"
  "${PROJECT_NAME}-aiops-worker-bottleneck-observed"
)

aws cloudwatch delete-alarms \
  --alarm-names "${ALARMS[@]}" \
  --region "$AWS_REGION" || true

echo "Deleted AIOps alarms."

if [[ "${DELETE_TOPIC:-false}" == "true" ]]; then
  TOPIC_ARN="$(aws sns create-topic --name "$TOPIC_NAME" --query TopicArn --output text --region "$AWS_REGION" 2>/dev/null || true)"
  if [[ -n "$TOPIC_ARN" && "$TOPIC_ARN" != "None" ]]; then
    aws sns delete-topic --topic-arn "$TOPIC_ARN" --region "$AWS_REGION" || true
    echo "Deleted SNS topic: ${TOPIC_NAME}"
  fi
fi
