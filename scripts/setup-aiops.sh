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
TOPIC_NAME="${AIOPS_SNS_TOPIC_NAME:-${SNS_TOPIC_NAME:-${PROJECT_NAME}-traffic-alerts}}"
ALERT_EMAIL="${AIOPS_ALERT_EMAIL:-${ALERT_EMAIL:-}}"
PERIOD="${AIOPS_ANOMALY_PERIOD_SECONDS:-60}"
EVALUATION_PERIODS="${AIOPS_ANOMALY_EVALUATION_PERIODS:-2}"
STDDEV="${AIOPS_ANOMALY_STDDEV:-2}"
QUEUE_THRESHOLD="${AIOPS_QUEUE_DEPTH_THRESHOLD:-1000}"
ERROR_THRESHOLD="${AIOPS_5XX_THRESHOLD:-10}"

mkdir -p generated/aiops-alarms

ALARM_ACTION_ARGS=()
if [[ -n "$ALERT_EMAIL" ]]; then
  echo "Creating or reusing SNS topic for AIOps alerts: ${TOPIC_NAME}"
  TOPIC_ARN="$(aws sns create-topic --name "$TOPIC_NAME" --query TopicArn --output text --region "$AWS_REGION")"
  EXISTING_SUB="$(aws sns list-subscriptions-by-topic \
    --topic-arn "$TOPIC_ARN" \
    --query "Subscriptions[?Endpoint=='${ALERT_EMAIL}'].SubscriptionArn | [0]" \
    --output text \
    --region "$AWS_REGION" || true)"
  if [[ "$EXISTING_SUB" == "None" || -z "$EXISTING_SUB" ]]; then
    aws sns subscribe \
      --topic-arn "$TOPIC_ARN" \
      --protocol email \
      --notification-endpoint "$ALERT_EMAIL" \
      --region "$AWS_REGION" >/dev/null
    echo "IMPORTANT: Check ${ALERT_EMAIL} and click Confirm subscription."
  fi
  ALARM_ACTION_ARGS=(--alarm-actions "$TOPIC_ARN")
else
  echo "ALERT_EMAIL/AIOPS_ALERT_EMAIL is not set. Alarms will be created without email actions."
fi

create_anomaly_alarm() {
  local metric_name="$1"
  local stat="$2"
  local alarm_suffix="$3"
  local description="$4"
  local alarm_name="${PROJECT_NAME}-aiops-${alarm_suffix}"
  local metric_file="generated/aiops-alarms/${alarm_suffix}.json"

  cat > "$metric_file" <<JSON
[
  {
    "Id": "m1",
    "MetricStat": {
      "Metric": {
        "Namespace": "${NAMESPACE}",
        "MetricName": "${metric_name}"
      },
      "Period": ${PERIOD},
      "Stat": "${stat}"
    },
    "ReturnData": true
  },
  {
    "Id": "ad1",
    "Expression": "ANOMALY_DETECTION_BAND(m1, ${STDDEV})",
    "Label": "Expected range for ${metric_name}",
    "ReturnData": true
  }
]
JSON

  aws cloudwatch put-metric-alarm \
    --alarm-name "$alarm_name" \
    --alarm-description "$description" \
    --comparison-operator GreaterThanUpperThreshold \
    --evaluation-periods "$EVALUATION_PERIODS" \
    --datapoints-to-alarm "$EVALUATION_PERIODS" \
    --threshold-metric-id ad1 \
    --metrics "file://${metric_file}" \
    --treat-missing-data notBreaching \
    "${ALARM_ACTION_ARGS[@]}" \
    --region "$AWS_REGION"

  echo "Created/updated anomaly alarm: ${alarm_name}"
}

create_threshold_alarm() {
  local metric_name="$1"
  local stat="$2"
  local threshold="$3"
  local alarm_suffix="$4"
  local description="$5"
  local alarm_name="${PROJECT_NAME}-aiops-${alarm_suffix}"

  aws cloudwatch put-metric-alarm \
    --alarm-name "$alarm_name" \
    --alarm-description "$description" \
    --namespace "$NAMESPACE" \
    --metric-name "$metric_name" \
    --statistic "$stat" \
    --period "$PERIOD" \
    --evaluation-periods 1 \
    --threshold "$threshold" \
    --comparison-operator GreaterThanOrEqualToThreshold \
    --treat-missing-data notBreaching \
    "${ALARM_ACTION_ARGS[@]}" \
    --region "$AWS_REGION"

  echo "Created/updated threshold alarm: ${alarm_name}"
}

create_anomaly_alarm "NginxRequestCount" "Sum" "traffic-anomaly" "AIOps: traffic volume is above the learned normal band."
create_anomaly_alarm "ApiLatencyMs" "Average" "latency-anomaly" "AIOps: API latency is above the learned normal band."
create_anomaly_alarm "QueueDepth" "Maximum" "queue-depth-anomaly" "AIOps: queue depth is above the learned normal band."
create_threshold_alarm "Api5xxCount" "Sum" "$ERROR_THRESHOLD" "5xx-error-spike" "AIOps: API 5xx errors crossed the classroom threshold."
create_threshold_alarm "Nginx5xxCount" "Sum" "$ERROR_THRESHOLD" "nginx-5xx-error-spike" "AIOps: NGINX 5xx errors crossed the classroom threshold."
create_threshold_alarm "QueueDepth" "Maximum" "$QUEUE_THRESHOLD" "queue-depth-high" "AIOps: Queue depth crossed the classroom threshold."
create_threshold_alarm "AiopsInjectedErrors" "Sum" 1 "injected-error-observed" "AIOps lab: controlled injected errors were observed."
create_threshold_alarm "AiopsWorkerBottleneck" "Sum" 1 "worker-bottleneck-observed" "AIOps lab: worker bottleneck marker was observed."

echo
echo "AIOps setup complete."
echo "Dashboard: CloudWatch > Dashboards > ${PROJECT_NAME}"
echo "Alarms:    CloudWatch > Alarms > filter '${PROJECT_NAME}-aiops'"
echo "AIOps UI:  http://EC2_PUBLIC_IP/aiops"
echo
echo "Note: anomaly alarms need baseline data. Run normal periodic load for 15-30 minutes before relying on anomaly bands."
