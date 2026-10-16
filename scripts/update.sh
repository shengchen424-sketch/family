#!/usr/bin/env bash
# Deploy the latest code from GitHub.
#   bash ~/family/scripts/update.sh staging   # → /root/family-staging, service family-assets-staging (port 8446, fictional data)
#   bash ~/family/scripts/update.sh           # → production /root/family, service family-assets (port 8444, real family data)
# Release rule: every change goes to staging first; production only after tests pass here AND the change was approved
# when it touches server.js, data validation, permissions, deletion or storage layout.
set -euo pipefail
MODE="${1:-prod}"
if [ "$MODE" = "staging" ]; then DIR=/root/family-staging; SVC=family-assets-staging; else DIR="$(cd "$(dirname "$0")/.." && pwd)"; SVC=family-assets; fi
cd "$DIR"
git fetch --quiet origin
git reset --hard --quiet origin/main
python3 scripts/build.py
node --check server.js
node tests/logic.test.js >/dev/null && node tests/accounting.test.js >/dev/null && node tests/server.test.js >/dev/null
if [ "$MODE" != "staging" ]; then
  # production guard: never deploy while the staging service is failing
  if systemctl is-enabled family-assets-staging >/dev/null 2>&1 && ! systemctl is-active --quiet family-assets-staging; then echo "staging service is down; fix staging before production"; exit 1; fi
fi
if [ "$(id -u)" -eq 0 ]; then systemctl restart "$SVC"; else sudo systemctl restart "$SVC"; fi
sleep 1
systemctl is-active --quiet "$SVC" || { echo "$SVC failed to start"; journalctl -u "$SVC" -n 20 --no-pager; exit 1; }
echo "[$MODE] updated to $(git rev-parse --short HEAD) at $(date '+%F %T')"
