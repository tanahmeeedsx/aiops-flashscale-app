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
DASHBOARD_NAME="${PROJECT_NAME}"

echo "Using PROJECT_NAME=${PROJECT_NAME}"
echo "Using AWS_REGION=${AWS_REGION}"
echo "Using NAMESPACE=${NAMESPACE}"

./scripts/create-log-groups.sh

put_filter() {
  local group="$1"
  local name="$2"
  local pattern="$3"
  local metric="$4"
  local value="$5"
  local unit="$6"

  aws logs put-metric-filter \
    --log-group-name "$group" \
    --filter-name "$name" \
    --filter-pattern "$pattern" \
    --metric-transformations metricName="$metric",metricNamespace="$NAMESPACE",metricValue="$value",unit="$unit" \
    --region "$AWS_REGION"
}

API_GROUP="/${PROJECT_NAME}/api"
WORKER_GROUP="/${PROJECT_NAME}/worker"
NGINX_GROUP="/${PROJECT_NAME}/nginx"

put_filter "$API_GROUP" "ApiRequestCount" '{ $.event_type = "request" }' "RequestCount" "1" "Count"
put_filter "$API_GROUP" "Api4xxCount" '{ $.event_type = "request" && $.status_code >= 400 && $.status_code < 500 }' "Api4xxCount" "1" "Count"
put_filter "$API_GROUP" "Api5xxCount" '{ $.event_type = "request" && $.status_code >= 500 }' "Api5xxCount" "1" "Count"
put_filter "$API_GROUP" "ApiLatencyMs" '{ $.event_type = "request" }' "ApiLatencyMs" "$.latency_ms" "Milliseconds"
put_filter "$API_GROUP" "OrdersAccepted" '{ $.event_type = "order_accepted" }' "OrdersAccepted" "1" "Count"

put_filter "$API_GROUP" "AiopsScenarioActivated" '{ $.event_type = "aiops_scenario_activated" }' "AiopsScenarioActivated" "1" "Count"
put_filter "$API_GROUP" "AiopsScenarioReset" '{ $.event_type = "aiops_scenario_reset" }' "AiopsScenarioReset" "1" "Count"
put_filter "$API_GROUP" "AiopsInjectedErrors" '{ $.event_type = "aiops_injected_error" }' "AiopsInjectedErrors" "1" "Count"
put_filter "$API_GROUP" "AiopsInjectedLatency" '{ $.event_type = "aiops_injected_latency" }' "AiopsInjectedLatency" "$.latency_ms" "Milliseconds"
put_filter "$API_GROUP" "AiopsLogAnomalies" '{ $.event_type = "aiops_log_anomaly" }' "AiopsLogAnomalies" "1" "Count"

put_filter "$WORKER_GROUP" "OrdersProcessed" '{ $.event_type = "order_processed" }' "OrdersProcessed" "1" "Count"
put_filter "$WORKER_GROUP" "QueueDepth" '{ $.event_type = "worker_stats" }' "QueueDepth" "$.queue_depth" "Count"
put_filter "$WORKER_GROUP" "AiopsWorkerBottleneck" '{ $.event_type = "aiops_worker_bottleneck" }' "AiopsWorkerBottleneck" "1" "Count"

put_filter "$NGINX_GROUP" "NginxRequestCount" '{ $.source = "nginx" }' "NginxRequestCount" "1" "Count"
put_filter "$NGINX_GROUP" "Nginx5xxCount" '{ $.source = "nginx" && $.status >= 500 }' "Nginx5xxCount" "1" "Count"
put_filter "$NGINX_GROUP" "NginxRequestTime" '{ $.source = "nginx" }' "NginxRequestTime" "$.request_time" "Seconds"

mkdir -p generated

sed "s#__PROJECT_NAME__#${PROJECT_NAME}#g" \
  configs/cloudwatch-agent-template.json > generated/cloudwatch-agent.json

if [[ -x /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl ]]; then
  /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
    -a fetch-config \
    -m ec2 \
    -s \
    -c "file:${APP_DIR}/generated/cloudwatch-agent.json"
else
  echo "CloudWatch Agent binary not found. Run sudo ./scripts/setup-ec2.sh first."
fi

TOKEN="$(curl -fsS -X PUT \
  "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" || true)"

if [[ -n "$TOKEN" ]]; then
  INSTANCE_ID="$(curl -fsS \
    -H "X-aws-ec2-metadata-token: $TOKEN" \
    "http://169.254.169.254/latest/meta-data/instance-id" || echo "UNKNOWN_INSTANCE")"
else
  INSTANCE_ID="$(curl -fsS \
    "http://169.254.169.254/latest/meta-data/instance-id" || echo "UNKNOWN_INSTANCE")"
fi

export PROJECT_NAME AWS_REGION NAMESPACE INSTANCE_ID

python3 <<'PY'
import json
import os

region = os.environ["AWS_REGION"]
namespace = os.environ["NAMESPACE"]
instance_id = os.environ["INSTANCE_ID"]

def metric_widget(x, y, w, h, title, metrics, stat="Sum"):
    return {
        "type": "metric",
        "x": x,
        "y": y,
        "width": w,
        "height": h,
        "properties": {
            "region": region,
            "title": title,
            "view": "timeSeries",
            "stat": stat,
            "period": 60,
            "metrics": metrics,
        },
    }

dashboard = {
    "widgets": [
        {
            "type": "text",
            "x": 0,
            "y": 0,
            "width": 24,
            "height": 2,
            "properties": {
                "markdown": "# FlashScale DLT + AIOps Dashboard\nTarget app: EC2 + Docker Compose. Load: AWS Distributed Load Testing with k6. AIOps Lab: controlled latency, error, log, and queue-backlog scenarios."
            },
        },
        metric_widget(0, 2, 12, 6, "API and NGINX Requests", [[namespace, "RequestCount"], [namespace, "NginxRequestCount"]]),
        metric_widget(12, 2, 12, 6, "Latency: API p95 and NGINX avg", [
            [namespace, "ApiLatencyMs", {"stat": "p95", "label": "API p95 ms"}],
            [namespace, "ApiLatencyMs", {"stat": "Average", "label": "API avg ms"}],
            [namespace, "NginxRequestTime", {"stat": "Average", "label": "NGINX avg sec", "yAxis": "right"}],
        ], stat="Average"),
        metric_widget(0, 8, 12, 6, "Errors", [[namespace, "Api4xxCount"], [namespace, "Api5xxCount"], [namespace, "Nginx5xxCount"], [namespace, "AiopsInjectedErrors"]]),
        metric_widget(12, 8, 12, 6, "Orders and Queue Depth", [
            [namespace, "OrdersAccepted", {"stat": "Sum"}],
            [namespace, "OrdersProcessed", {"stat": "Sum"}],
            [namespace, "QueueDepth", {"stat": "Maximum", "yAxis": "right"}],
        ]),
        metric_widget(0, 14, 12, 6, "EC2 CPU and Network", [
            ["AWS/EC2", "CPUUtilization", "InstanceId", instance_id, {"stat": "Average"}],
            ["AWS/EC2", "NetworkIn", "InstanceId", instance_id, {"stat": "Sum", "yAxis": "right"}],
            ["AWS/EC2", "NetworkOut", "InstanceId", instance_id, {"stat": "Sum", "yAxis": "right"}],
        ], stat="Average"),
        metric_widget(12, 14, 12, 6, "Memory, Disk, and TCP Connections", [
            [{"expression": "SEARCH('{CWAgent,InstanceId} MetricName=\"mem_used_percent\"', 'Average', 60)", "id": "mem", "label": "Memory used %"}],
            [{"expression": "SEARCH('{CWAgent,InstanceId} MetricName=\"used_percent\"', 'Average', 60)", "id": "disk", "label": "Disk used %"}],
            [{"expression": "SEARCH('{CWAgent,InstanceId} MetricName=\"tcp_established\"', 'Average', 60)", "id": "tcp", "label": "TCP established", "yAxis": "right"}],
        ], stat="Average"),
        metric_widget(0, 20, 12, 6, "AIOps Scenario Signals", [
            [namespace, "AiopsScenarioActivated", {"stat": "Sum"}],
            [namespace, "AiopsScenarioReset", {"stat": "Sum"}],
            [namespace, "AiopsLogAnomalies", {"stat": "Sum"}],
            [namespace, "AiopsWorkerBottleneck", {"stat": "Sum"}],
        ]),
        metric_widget(12, 20, 12, 6, "AIOps Injected Latency", [
            [namespace, "AiopsInjectedLatency", {"stat": "Average", "label": "Injected latency avg ms"}],
            [namespace, "AiopsInjectedLatency", {"stat": "Maximum", "label": "Injected latency max ms"}],
        ], stat="Average"),
        {
            "type": "log",
            "x": 0,
            "y": 26,
            "width": 24,
            "height": 6,
            "properties": {
                "region": region,
                "title": "Recent AIOps and Error Logs",
                "query": f"SOURCE '/{os.environ['PROJECT_NAME']}/api' | SOURCE '/{os.environ['PROJECT_NAME']}/worker' | fields @timestamp, source, event_type, scenario, message, status_code, latency_ms, delay_ms, queue_depth | filter event_type like /aiops/ or status_code >= 500 | sort @timestamp desc | limit 40",
                "view": "table"
            }
        }
    ]
}

os.makedirs("generated", exist_ok=True)
with open("generated/dashboard.json", "w", encoding="utf-8") as f:
    json.dump(dashboard, f, indent=2)
PY

jq . generated/dashboard.json > /dev/null

aws cloudwatch put-dashboard \
  --dashboard-name "$DASHBOARD_NAME" \
  --dashboard-body "file://generated/dashboard.json" \
  --region "$AWS_REGION"

echo "CloudWatch setup complete."
echo "Dashboard: ${DASHBOARD_NAME}"
echo "Region: ${AWS_REGION}"
echo "InstanceId: ${INSTANCE_ID}"
echo "AIOps widgets added to the same dashboard."
