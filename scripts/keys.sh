#!/usr/bin/env bash
# Manage access keys on the VPS.
#   bash scripts/keys.sh list                 # names only (keys are never printed except when just created)
#   bash scripts/keys.sh add Liza             # create a random key for Liza, print it once, restart the service
#   bash scripts/keys.sh rotate Liza          # replace Liza's key with a new one
#   bash scripts/keys.sh remove Liza          # revoke Liza's key
#   bash scripts/keys.sh remove-temp          # drop the temporary FAMILY_KEYS line from the systemd unit
set -euo pipefail
cd "$(dirname "$0")/.."
KEYS_FILE="data/keys.txt"
UNIT="/etc/systemd/system/family-assets.service"
touch "$KEYS_FILE"; chmod 600 "$KEYS_FILE"
restart() { if [ "$(id -u)" -eq 0 ]; then systemctl restart family-assets; else sudo systemctl restart family-assets; fi; }
newkey() { node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"; }
cmd="${1:-list}"; name="${2:-}"
case "$cmd" in
  list)
    echo "密钥文件里的成员："; grep -v '^#' "$KEYS_FILE" | awk -F: 'NF>=2{print "  - "$2}'
    if grep -q 'FAMILY_KEYS=' "$UNIT" 2>/dev/null; then echo "注意：systemd 单元里还有临时密钥（属于：$(grep -o 'FAMILY_KEYS=[^ ]*' "$UNIT" | sed 's/FAMILY_KEYS=//' | tr ',' '\n' | cut -d: -f2 | paste -sd,)），正式使用前运行 remove-temp。"; fi ;;
  add|rotate)
    [ -n "$name" ] || { echo "用法：keys.sh $cmd 名字"; exit 1; }
    if [ "$cmd" = add ] && grep -q ":$name\$" "$KEYS_FILE"; then echo "$name 已有密钥，用 rotate 更换"; exit 1; fi
    k="$(newkey)"
    grep -v ":$name\$" "$KEYS_FILE" > "$KEYS_FILE.tmp" || true; echo "$k:$name" >> "$KEYS_FILE.tmp"; mv "$KEYS_FILE.tmp" "$KEYS_FILE"; chmod 600 "$KEYS_FILE"
    restart
    echo "$name 的新密钥（只显示这一次，请马上发给本人）："; echo; echo "  https://$(hostname -I | awk '{print $1}'):8444/?k=$k"; echo ;;
  remove)
    [ -n "$name" ] || { echo "用法：keys.sh remove 名字"; exit 1; }
    grep -v ":$name\$" "$KEYS_FILE" > "$KEYS_FILE.tmp" || true; mv "$KEYS_FILE.tmp" "$KEYS_FILE"; chmod 600 "$KEYS_FILE"
    restart; echo "已撤销 $name 的密钥" ;;
  remove-temp)
    if grep -q 'FAMILY_KEYS=' "$UNIT"; then
      sed -i '/^Environment=FAMILY_KEYS=/d' "$UNIT"; systemctl daemon-reload; restart
      echo "已删除单元里的临时密钥，现在只有 $KEYS_FILE 里的密钥有效。"
    else echo "单元里没有临时密钥。"; fi ;;
  *) echo "未知命令：$cmd"; exit 1 ;;
esac
