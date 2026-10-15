#!/usr/bin/env bash
# Pull the latest code from GitHub, rebuild the page, restart the service.
# Run on the VPS:  bash ~/family/scripts/update.sh
# Data (data/) and TLS files (*.pem) are git-ignored, so they are never touched.
set -euo pipefail
cd "$(dirname "$0")/.."
git fetch --quiet origin
git reset --hard --quiet origin/main
python3 scripts/build.py
node --check server.js
node tests/logic.test.js >/dev/null
if [ "$(id -u)" -eq 0 ]; then systemctl restart family-assets; else sudo systemctl restart family-assets; fi
echo "updated to $(git rev-parse --short HEAD) at $(date '+%F %T')"
