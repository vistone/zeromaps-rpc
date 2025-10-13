#!/bin/bash
# ZeroMaps RPC 自动更新脚本
# 自动检测 GitHub 新版本并更新服务
# 使用方法: 
#   1. 手动运行: sudo bash auto-update.sh
#   2. Cron 定时: */5 * * * * cd /opt/zeromaps-rpc && sudo bash auto-update.sh >> /var/log/zeromaps-auto-update.log 2>&1

set -e

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
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

# 检查是否有其他更新进程在运行
if [ -f "$LOCK_FILE" ]; then
    # 检查锁文件是否过期（超过30分钟认为是僵尸锁）
    if [ $(($(date +%s) - $(stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0))) -gt 1800 ]; then
        log "⚠️  发现过期的锁文件，清理..."
        rm -f "$LOCK_FILE"
    else
        log "ℹ️  已有更新进程在运行，跳过"
        exit 0
    fi
fi

# 创建锁文件
touch "$LOCK_FILE"
trap "rm -f $LOCK_FILE" EXIT

log "======================================"
log "🔍 检查 GitHub 更新..."
log "======================================"

# 检查目录
if [ ! -d "$INSTALL_DIR" ]; then
    log "❌ 错误: $INSTALL_DIR 目录不存在"
    exit 1
fi

cd $INSTALL_DIR

# 检查是否是 git 仓库
if [ ! -d ".git" ]; then
    log "❌ 错误: 不是 git 仓库"
    exit 1
fi

# 获取当前本地版本
if [ -f "package.json" ]; then
    LOCAL_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')
    log "📦 本地版本: v$LOCAL_VERSION"
else
    LOCAL_VERSION="unknown"
    log "⚠️  无法读取本地版本"
fi

# 获取当前 commit
LOCAL_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
log "📝 本地 commit: ${LOCAL_COMMIT:0:8}"

# Fetch 远程更新（不合并）
log "🔄 检查远程仓库..."
git fetch origin master 2>&1 | tee -a $LOG_FILE
FETCH_EXIT=$?

if [ $FETCH_EXIT -ne 0 ]; then
    log "❌ git fetch 失败，退出码: $FETCH_EXIT"
    exit 1
fi

# 获取远程 commit
REMOTE_COMMIT=$(git rev-parse origin/master 2>/dev/null || echo "unknown")
log "📝 远程 commit: ${REMOTE_COMMIT:0:8}"

# 比较版本
if [ "$LOCAL_COMMIT" = "$REMOTE_COMMIT" ]; then
    log "✅ 已是最新版本，无需更新"
    exit 0
fi

log "🆕 发现新版本！"
log "   本地: ${LOCAL_COMMIT:0:8}"
log "   远程: ${REMOTE_COMMIT:0:8}"

# 显示更新内容
log ""
log "📋 更新内容:"
git log --oneline HEAD..origin/master | head -10 | while read line; do
    log "   $line"
done | tee -a $LOG_FILE

log ""
log "======================================"
log "🚀 开始自动更新..."
log "======================================"

# 0. 先更新脚本自己（解决"鸡生蛋"问题）
log "[0/5] 更新脚本自身..."
log "   保存本地修改..."
git diff > /tmp/zeromaps-local-changes-$(date +%s).patch 2>/dev/null || true
log "   强制重置到远程版本..."
git reset --hard origin/master 2>&1 | tee -a $LOG_FILE
git clean -fd 2>&1 | tee -a $LOG_FILE

SCRIPT_UPDATED_COMMIT=$(git rev-parse HEAD 2>/dev/null)
log "   脚本已更新到: ${SCRIPT_UPDATED_COMMIT:0:8}"

# 如果脚本被更新了，重新执行新版本脚本
if [ "$SCRIPT_UPDATED_COMMIT" != "$LOCAL_COMMIT" ]; then
    log "🔄 脚本已更新，重新执行新版本..."
    log ""
    
    # 删除锁文件（允许新脚本创建）
    rm -f "$LOCK_FILE"
    
    # 重新执行新版本的脚本
    exec bash "$INSTALL_DIR/auto-update.sh"
    exit 0
fi

log "✅ 脚本已是最新版本"
log ""

# 1. 拉取代码（强制同步，丢弃本地所有修改）
log "[1/5] 拉取最新代码..."

# 保存本地修改到备份文件（如果有）
log "   保存本地修改到备份..."
git diff > /tmp/zeromaps-local-changes-$(date +%s).patch 2>/dev/null || true

# 强制重置到远程版本（最可靠的方式）
log "   强制同步到远程版本..."
git reset --hard origin/master 2>&1 | tee -a $LOG_FILE
git clean -fd 2>&1 | tee -a $LOG_FILE

# 拉取代码（此时应该不会有冲突）
log "   执行 git pull..."
git pull origin master 2>&1 | tee -a $LOG_FILE
PULL_EXIT=$?

if [ $PULL_EXIT -ne 0 ]; then
    log "❌ git pull 失败，退出码: $PULL_EXIT"
    exit 1
fi

# 验证代码已更新
UPDATED_COMMIT=$(git rev-parse HEAD 2>/dev/null)
log "   更新后 commit: ${UPDATED_COMMIT:0:8}"

if [ "$UPDATED_COMMIT" != "$REMOTE_COMMIT" ]; then
    log "❌ 错误: 本地 commit 与远程不一致"
    log "   本地: $UPDATED_COMMIT"
    log "   远程: $REMOTE_COMMIT"
    exit 1
fi

log "✅ 代码拉取完成 (v$LOCAL_VERSION → 远程最新版)"

# 2. 更新依赖
log ""
log "[2/5] 更新 npm 依赖..."
npm install 2>&1 | tee -a $LOG_FILE
log "✅ 依赖更新完成"

# 3. 编译代码
log ""
log "[3/5] 编译 TypeScript 代码..."
npm run build 2>&1 | tee -a $LOG_FILE
if [ $? -eq 0 ]; then
    log "✅ 代码编译成功"
else
    log "❌ 代码编译失败"
    exit 1
fi

# 4. 重启服务
log ""
log "[4/5] 重启 PM2 服务..."

# 清理端口占用
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

# 5. 更新 Caddy（如果已安装）
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

# 验证服务状态
log ""
log "======================================"
log "✅ 自动更新完成！"
log "======================================"

sleep 2

# 检查服务状态
log ""
log "📊 服务状态:"
pm2 list | tee -a $LOG_FILE

# 获取更新后的版本
if [ -f "package.json" ]; then
    NEW_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/')
    log ""
    log "🎉 更新完成: v$LOCAL_VERSION → v$NEW_VERSION"
fi

# 检查端口
log ""
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

