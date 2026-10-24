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
NAMESPACE="FlashScale/${PROJECT_NAME}"
TOPIC_NAME="${SNS_TOPIC_NAME:-${PROJECT_NAME}-traffic-alerts}"
ALERT_EMAIL="${ALERT_EMAIL:-}"
ALERT_THRESHOLDS="${ALERT_THRESHOLDS:-10000,20000,30000,40000,50000,60000,70000,80000,90000,100000}"
ALERT_PERIOD_SECONDS="${ALERT_PERIOD_SECONDS:-60}"
ALERT_EVALUATION_PERIODS="${ALERT_EVALUATION_PERIODS:-1}"
ALERT_METRIC="${ALERT_METRIC:-NginxRequestCount}"
ALERT_STAT="${ALERT_STAT:-Sum}"

usage() {
  cat <<USAGE
Usage:
  ALERT_EMAIL=bongodevbootcamp@gmail.com ./scripts/setup-sns-alerts.sh

Optional environment variables:
  PROJECT_NAME=flashscale-dlt
  AWS_REGION=us-west-2
  SNS_TOPIC_NAME=flashscale-dlt-traffic-alerts
  ALERT_THRESHOLDS=10000,20000,30000,40000,50000,60000,70000,80000,90000,100000
  ALERT_PERIOD_SECONDS=60
  ALERT_EVALUATION_PERIODS=1
  ALERT_METRIC=NginxRequestCount
  ALERT_STAT=Sum

Meaning:
  The default alarms fire when NGINX request count per 60 seconds reaches each threshold.
  Example: 10000 means 10,000 requests/minute, not 10,000 virtual users.
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ -z "$ALERT_EMAIL" ]]; then
  echo "ERROR: ALERT_EMAIL is required."
  echo
  usage
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI is not installed. Run sudo ./scripts/setup-ec2.sh first."
  exit 1
fi

echo "Creating or reusing SNS topic: ${TOPIC_NAME}"
TOPIC_ARN="$(aws sns create-topic \
  --name "$TOPIC_NAME" \
  --query TopicArn \
  --output text \
  --region "$AWS_REGION")"

echo "SNS topic ARN: ${TOPIC_ARN}"

EXISTING_SUB="$(aws sns list-subscriptions-by-topic \
  --topic-arn "$TOPIC_ARN" \
  --query "Subscriptions[?Endpoint=='${ALERT_EMAIL}'].SubscriptionArn | [0]" \
  --output text \
  --region "$AWS_REGION" || true)"

if [[ "$EXISTING_SUB" == "None" || -z "$EXISTING_SUB" ]]; then
  echo "Subscribing ${ALERT_EMAIL} to ${TOPIC_NAME}"
  aws sns subscribe \
    --topic-arn "$TOPIC_ARN" \
    --protocol email \
    --notification-endpoint "$ALERT_EMAIL" \
    --region "$AWS_REGION" >/dev/null
  echo "IMPORTANT: Check ${ALERT_EMAIL} and click 'Confirm subscription' from AWS Notifications."
else
  echo "Email already subscribed or pending: ${ALERT_EMAIL} (${EXISTING_SUB})"
fi

echo "Creating CloudWatch alarms in namespace: ${NAMESPACE}"
IFS=',' read -r -a THRESHOLD_ARRAY <<< "$ALERT_THRESHOLDS"

for raw_threshold in "${THRESHOLD_ARRAY[@]}"; do
  threshold="$(echo "$raw_threshold" | tr -d '[:space:]')"
  [[ -z "$threshold" ]] && continue

  alarm_name="${PROJECT_NAME}-traffic-${threshold}-requests-per-${ALERT_PERIOD_SECONDS}s"
  description="FlashScale traffic alert: ${ALERT_METRIC} ${ALERT_STAT} >= ${threshold} per ${ALERT_PERIOD_SECONDS}s. This is request volume, not virtual-user count."

  aws cloudwatch put-metric-alarm \
    --alarm-name "$alarm_name" \
    --alarm-description "$description" \
    --namespace "$NAMESPACE" \
    --metric-name "$ALERT_METRIC" \
    --statistic "$ALERT_STAT" \
    --period "$ALERT_PERIOD_SECONDS" \
    --evaluation-periods "$ALERT_EVALUATION_PERIODS" \
    --threshold "$threshold" \
    --comparison-operator GreaterThanOrEqualToThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "$TOPIC_ARN" \
    --region "$AWS_REGION"

  echo "Created/updated alarm: ${alarm_name}"
done

echo
echo "SNS traffic alerts are ready."
echo "Dashboard: CloudWatch > Dashboards > ${PROJECT_NAME}"
echo "Alarms:    CloudWatch > Alarms > filter '${PROJECT_NAME}-traffic'"
echo "Topic:     SNS > Topics > ${TOPIC_NAME}"
echo
echo "Reminder: email delivery starts only after the SNS subscription is confirmed."
