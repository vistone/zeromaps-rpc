#!/bin/bash
# ZeroMaps RPC 自动更新脚本
# 由 GitHub Webhook 或定时任务触发

set -e

INSTALL_DIR="/opt/zeromaps-rpc"
LOG_FILE="/var/log/zeromaps-auto-update.log"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a $LOG_FILE
}

cd $INSTALL_DIR

log "======================================"
log "🔍 检查更新"
log "======================================"

# 记录当前版本
CURRENT=$(git rev-parse HEAD)
log "当前: ${CURRENT:0:8}"

# 获取远程更新
git fetch origin master >/dev/null 2>&1
REMOTE=$(git rev-parse origin/master)
log "远程: ${REMOTE:0:8}"

# 比较
if [ "$CURRENT" = "$REMOTE" ]; then
    log "✅ 已是最新版本"
    exit 0
fi

log "🆕 发现更新"

# 执行更新
log ""
log "======================================"
log "🚀 执行更新"
log "======================================"

# 1. 更新代码
log "[1/4] git reset..."
git reset --hard origin/master >/dev/null 2>&1
git clean -fd >/dev/null 2>&1

# 2. 安装依赖
log "[2/4] npm install..."
npm install >/dev/null 2>&1

# 3. 编译
log "[3/4] npm run build..."
npm run build >/dev/null 2>&1

# 4. 重启
log "[4/4] pm2 restart..."
pm2 restart zeromaps-rpc >/dev/null 2>&1
pm2 save >/dev/null 2>&1

# 5. Caddy（如果有）
if systemctl is-active caddy >/dev/null 2>&1; then
    DOMAIN=$(grep -oP '^[a-z0-9.-]+\.zeromaps\.(cn|com\.cn)' /etc/caddy/Caddyfile | head -1)
    if [ -n "$DOMAIN" ]; then
        sed "s|{DOMAIN}|$DOMAIN|g" Caddyfile > /etc/caddy/Caddyfile
        systemctl reload caddy >/dev/null 2>&1
    fi
fi

log "✅ 更新完成"
exit 0
