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

TOPIC_ARN="$(aws sns list-topics \
  --query "Topics[?ends_with(TopicArn, ':${TOPIC_NAME}')].TopicArn | [0]" \
  --output text \
  --region "$AWS_REGION")"

if [[ "$TOPIC_ARN" == "None" || -z "$TOPIC_ARN" ]]; then
  echo "ERROR: SNS topic not found. Run ALERT_EMAIL=bongodevbootcamp@gmail.com ./scripts/setup-sns-alerts.sh first."
  exit 1
fi

aws sns publish \
  --topic-arn "$TOPIC_ARN" \
  --subject "FlashScale SNS test notification" \
  --message "This is a test notification from FlashScale. If you received this, SNS email alerts are working." \
  --region "$AWS_REGION" >/dev/null

echo "Test notification published to ${TOPIC_NAME}. Check your email."
