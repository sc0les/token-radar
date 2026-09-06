#!/usr/bin/env bash
# Thin wrapper for launchd / cron. Do not load LaunchAgents without operator approval.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
exec node "$ROOT/bin/radar.js" once --chains robinhood,base,solana --top 25 "$@"
