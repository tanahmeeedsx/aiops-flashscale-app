#!/usr/bin/env bash
set -euo pipefail
if [[ "${EUID}" -ne 0 ]]; then echo "Run with sudo."; exit 1; fi
APP_DIR="${APP_DIR:-/opt/flashscale-dlt}"; SCHEDULE="${SCHEDULE:-*/15 * * * *}"; VUS="${VUS:-25}"; DURATION="${DURATION:-2m}"; ORDER_RATIO="${ORDER_RATIO:-0.05}"
LOG_FILE="/var/log/flashscale-periodic-load.log"; RUNNER="/usr/local/bin/flashscale-periodic-load"
cat > "$RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$APP_DIR"
echo "[\$(date -Is)] Starting periodic small load: VUS=$VUS DURATION=$DURATION ORDER_RATIO=$ORDER_RATIO"
VUS="$VUS" DURATION="$DURATION" ORDER_RATIO="$ORDER_RATIO" ./scripts/run-small-local-load.sh
echo "[\$(date -Is)] Finished periodic small load"
EOF
chmod +x "$RUNNER"; touch "$LOG_FILE"; chmod 644 "$LOG_FILE"
cat > /etc/cron.d/flashscale-periodic-load <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
$SCHEDULE root $RUNNER >> $LOG_FILE 2>&1
EOF
chmod 644 /etc/cron.d/flashscale-periodic-load
echo "Installed periodic small load cron: $SCHEDULE"
