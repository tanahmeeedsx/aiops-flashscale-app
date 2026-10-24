#!/usr/bin/env bash
set -euo pipefail
if [[ "${EUID}" -ne 0 ]]; then echo "Run with sudo."; exit 1; fi
rm -f /etc/cron.d/flashscale-periodic-load /usr/local/bin/flashscale-periodic-load
echo "Removed periodic small load cron."
