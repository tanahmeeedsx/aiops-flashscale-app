#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
BASE_URL=""; PEAK_VUS="1000"; ORDER_RATIO="0.05"; DURATION=""; LOCAL_ONLY="false"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2 ;;
    --peak-vus) PEAK_VUS="$2"; shift 2 ;;
    --order-ratio) ORDER_RATIO="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --local-only) LOCAL_ONLY="true"; shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done
if [[ -z "$BASE_URL" ]]; then echo "Missing --base-url"; exit 1; fi
mkdir -p generated dlt/dist
OUT="generated/flashscale-k6.js"
[[ "$LOCAL_ONLY" == "true" ]] && OUT="generated/flashscale-k6-local.js"
sed -e "s#__BASE_URL__#${BASE_URL%/}#g" -e "s#__PEAK_VUS__#${PEAK_VUS}#g" -e "s#__ORDER_RATIO__#${ORDER_RATIO}#g" dlt/templates/flashscale-k6.template.js > "$OUT"
if [[ -n "$DURATION" ]]; then
  python3 - <<PY_LOCAL
from pathlib import Path
p=Path('$OUT')
s=p.read_text()
s=s.replace('const FORCE_DURATION = null;', 'const FORCE_DURATION = "${DURATION}";')
p.write_text(s)
PY_LOCAL
fi
if [[ "$LOCAL_ONLY" == "true" ]]; then echo "Generated local k6 script: $OUT"; exit 0; fi
ZIP="dlt/dist/flashscale-k6-${PEAK_VUS}vus.zip"
rm -f "$ZIP"
( cd generated && cp flashscale-k6.js index.js && zip -q "../$ZIP" index.js && rm -f index.js )
echo "Created DLT k6 package: $ZIP"
