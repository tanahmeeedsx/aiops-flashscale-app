#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
if [[ -f .env ]]; then set -a; source .env; set +a; fi
PROJECT_NAME="${PROJECT_NAME:-flashscale-dlt}"
AWS_REGION="${AWS_REGION:-us-west-2}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
for suffix in api worker nginx redis loadgen system; do
  group="/${PROJECT_NAME}/${suffix}"
  aws logs create-log-group --log-group-name "$group" --region "$AWS_REGION" 2>/dev/null || true
  aws logs put-retention-policy --log-group-name "$group" --retention-in-days "$RETENTION_DAYS" --region "$AWS_REGION"
  echo "Ensured log group: $group"
done
