#!/bin/bash
# ZeroMaps RPC 自动更新脚本
# 自动检测 GitHub 新版本并更新服务

set -e

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

INSTALL_DIR="/opt/zeromaps-rpc"
LOG_FILE="/var/log/zeromaps-auto-update.log"
LOCK_FILE="/tmp/zeromaps-auto-update.lock"

# 创建日志目录
mkdir -p $(dirname $LOG_FILE)

# 日志函数
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a $LOG_FILE
}

# 检查锁文件
if [ -f "$LOCK_FILE" ]; then
    if [ $(($(date +%s) - $(stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0))) -gt 1800 ]; then
        log "⚠️  发现过期的锁文件，清理..."
        rm -f "$LOCK_FILE"
    else
        log "ℹ️  已有更新进程在运行，跳过"
        exit 0
    fi
fi

touch "$LOCK_FILE"
trap "rm -f $LOCK_FILE" EXIT

log "======================================"
log "🔍 检查 GitHub 更新..."
log "======================================"

# 检查目录
if [ ! -d "$INSTALL_DIR" ] || [ ! -d "$INSTALL_DIR/.git" ]; then
    log "❌ 错误: $INSTALL_DIR 不存在或不是 git 仓库"
    exit 1
fi

cd $INSTALL_DIR

# 获取原始版本
ORIGINAL_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
ORIGINAL_VERSION=$(grep '"version"' package.json 2>/dev/null | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/' || echo "unknown")

log "📦 当前版本: v$ORIGINAL_VERSION"
log "📝 当前 commit: ${ORIGINAL_COMMIT:0:8}"

# Fetch 远程更新
log "🔄 检查远程仓库..."
git fetch origin master 2>&1 | tee -a $LOG_FILE || {
    log "❌ git fetch 失败"
    exit 1
}

REMOTE_COMMIT=$(git rev-parse origin/master 2>/dev/null || echo "unknown")
log "📝 远程 commit: ${REMOTE_COMMIT:0:8}"

# 比较版本
if [ "$ORIGINAL_COMMIT" = "$REMOTE_COMMIT" ]; then
    log "✅ 已是最新版本，无需更新"
    exit 0
fi

log ""
log "🆕 发现新版本！"
log "   本地: ${ORIGINAL_COMMIT:0:8}"
log "   远程: ${REMOTE_COMMIT:0:8}"

# 显示更新内容
log ""
log "📋 更新内容:"
git log --oneline HEAD..origin/master | head -10 | while read line; do
    log "   $line"
done

log ""
log "======================================"
log "🚀 开始自动更新..."
log "======================================"

# 1. 强制同步代码
log "[1/5] 强制同步最新代码..."

# 保存本地修改
git diff > /tmp/zeromaps-backup-$(date +%s).patch 2>/dev/null || true

# 强制重置
git reset --hard origin/master 2>&1 | tee -a $LOG_FILE
git clean -fd 2>&1 | tee -a $LOG_FILE

UPDATED_COMMIT=$(git rev-parse HEAD 2>/dev/null)
NEW_VERSION=$(grep '"version"' package.json 2>/dev/null | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/' || echo "unknown")

log "✅ 代码同步完成"
log "   commit: ${UPDATED_COMMIT:0:8}"
log "   version: v$NEW_VERSION"

# 2. 更新依赖
log ""
log "[2/5] 更新 npm 依赖..."
npm install 2>&1 | tee -a $LOG_FILE
log "✅ 依赖更新完成"

# 3. 编译代码
log ""
log "[3/5] 编译 TypeScript 代码..."
npm run build 2>&1 | tee -a $LOG_FILE
if [ $? -ne 0 ]; then
    log "❌ 代码编译失败"
    exit 1
fi
log "✅ 代码编译成功"

# 4. 重启服务
log ""
log "[4/5] 重启 PM2 服务..."

# 清理端口
for port in 9527 9528; do
    if netstat -tlnp 2>/dev/null | grep -q ":$port.*LISTEN"; then
        log "   清理端口 $port..."
        fuser -k $port/tcp 2>/dev/null || true
        sleep 1
    fi
done

# 重启或启动服务
if pm2 describe zeromaps-rpc >/dev/null 2>&1; then
    log "   重启现有服务..."
    pm2 restart zeromaps-rpc 2>&1 | tee -a $LOG_FILE
else
    log "   启动新服务..."
    if [ -f "ecosystem.config.cjs" ]; then
        pm2 start ecosystem.config.cjs 2>&1 | tee -a $LOG_FILE
        pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
    else
        log "❌ 未找到 ecosystem.config.cjs"
        exit 1
    fi
fi

pm2 save 2>&1 | tee -a $LOG_FILE
log "✅ 服务重启完成"

# 5. 更新 Caddy
log ""
log "[5/5] 更新 Caddy 配置..."

if command -v caddy &>/dev/null && systemctl is-active caddy >/dev/null 2>&1; then
    LOCAL_IP=$(curl -s -4 ifconfig.me 2>/dev/null)
    CONFIG_FILE="$INSTALL_DIR/configs/vps-$LOCAL_IP.conf"
    
    if [ -f "$CONFIG_FILE" ]; then
        source $CONFIG_FILE
        sed "s|{DOMAIN}|$SERVER_DOMAIN|g" $INSTALL_DIR/Caddyfile > /etc/caddy/Caddyfile
        
        if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
            systemctl reload caddy >/dev/null 2>&1 || systemctl restart caddy
            log "✅ Caddy 配置已更新"
        else
            log "⚠️  Caddy 配置验证失败，跳过"
        fi
    else
        log "⚠️  未找到配置文件，跳过 Caddy 更新"
    fi
else
    log "ℹ️  Caddy 未安装或未运行，跳过"
fi

# 完成
log ""
log "======================================"
log "✅ 自动更新完成！"
log "======================================"

sleep 2

# 服务状态
log ""
log "📊 服务状态:"
pm2 list | tee -a $LOG_FILE

log ""
log "🎉 更新完成: v$ORIGINAL_VERSION → v$NEW_VERSION"
log ""

# 端口状态
log "🔌 端口状态:"
if netstat -tlnp 2>/dev/null | grep -q ":9527.*LISTEN"; then
    log "   ✅ RPC 端口 9527 正常"
else
    log "   ❌ RPC 端口 9527 未监听"
fi

if netstat -tlnp 2>/dev/null | grep -q ":9528.*LISTEN"; then
    log "   ✅ 监控端口 9528 正常"
else
    log "   ❌ 监控端口 9528 未监听"
fi

log ""
log "📝 完整日志: $LOG_FILE"
log ""
