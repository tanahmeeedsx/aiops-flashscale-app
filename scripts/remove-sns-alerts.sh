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
TOPIC_NAME="${SNS_TOPIC_NAME:-${PROJECT_NAME}-traffic-alerts}"
DELETE_TOPIC="${DELETE_TOPIC:-false}"

mapfile -t ALARMS < <(aws cloudwatch describe-alarms \
  --alarm-name-prefix "${PROJECT_NAME}-traffic" \
  --query 'MetricAlarms[].AlarmName' \
  --output text \
  --region "$AWS_REGION" | tr '\t' '\n' | sed '/^$/d')

if [[ ${#ALARMS[@]} -gt 0 ]]; then
  echo "Deleting ${#ALARMS[@]} traffic alarms..."
  aws cloudwatch delete-alarms --alarm-names "${ALARMS[@]}" --region "$AWS_REGION"
else
  echo "No matching traffic alarms found."
fi

if [[ "$DELETE_TOPIC" == "true" ]]; then
  TOPIC_ARN="$(aws sns list-topics \
    --query "Topics[?ends_with(TopicArn, ':${TOPIC_NAME}')].TopicArn | [0]" \
    --output text \
    --region "$AWS_REGION")"
  if [[ "$TOPIC_ARN" != "None" && -n "$TOPIC_ARN" ]]; then
    aws sns delete-topic --topic-arn "$TOPIC_ARN" --region "$AWS_REGION"
    echo "Deleted SNS topic: ${TOPIC_NAME}"
  else
    echo "SNS topic not found: ${TOPIC_NAME}"
  fi
else
  echo "SNS topic kept. To delete it too, run: sudo DELETE_TOPIC=true ./scripts/remove-sns-alerts.sh"
fi
