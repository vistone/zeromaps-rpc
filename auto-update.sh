#!/bin/bash
# ZeroMaps RPC 自动更新脚本
# 由 GitHub Webhook 或定时任务触发

set -e

# 配置
INSTALL_DIR="/opt/zeromaps-rpc"
LOG_FILE="/var/log/zeromaps-auto-update.log"
LOCK_FILE="/tmp/zeromaps-auto-update.lock"

# 日志函数
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a $LOG_FILE
}

# 清理函数
cleanup() {
    rm -f "$LOCK_FILE"
}
trap cleanup EXIT

# 检查锁文件（防止并发执行）
if [ -f "$LOCK_FILE" ]; then
    PID=$(cat "$LOCK_FILE")
    if ps -p $PID > /dev/null 2>&1; then
        log "⚠️  更新正在进行中（PID: $PID），退出"
        exit 0
    else
        log "⚠️  清理过期锁文件"
        rm -f "$LOCK_FILE"
    fi
fi

# 创建锁文件
echo $$ > "$LOCK_FILE"

# 检查目录
if [ ! -d "$INSTALL_DIR" ] || [ ! -d "$INSTALL_DIR/.git" ]; then
    log "❌ 错误: $INSTALL_DIR 不存在或不是 git 仓库"
    exit 1
fi

cd $INSTALL_DIR

log "======================================"
log "🔍 检查更新..."
log "======================================"

# 1. 记录当前版本
CURRENT_COMMIT=$(git rev-parse HEAD 2>/dev/null)
CURRENT_VERSION=$(grep '"version"' package.json 2>/dev/null | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/' || echo "unknown")

log "📦 当前版本: v$CURRENT_VERSION (commit: ${CURRENT_COMMIT:0:8})"

# 2. 清理本地修改（确保 fetch 能成功）
log "🧹 清理本地修改..."
git reset --hard HEAD >/dev/null 2>&1
git clean -fd >/dev/null 2>&1

# 3. 获取远程更新
log "🔄 获取远程更新..."
if ! timeout 30 git fetch origin master 2>&1 | tee -a $LOG_FILE; then
    log "❌ git fetch 失败"
    exit 1
fi

# 4. 获取远程最新版本
REMOTE_COMMIT=$(git rev-parse origin/master 2>/dev/null)
REMOTE_VERSION=$(git show origin/master:package.json 2>/dev/null | grep '"version"' | head -1 | sed 's/.*"\([0-9.]*\)".*/\1/' || echo "unknown")

log "📡 远程版本: v$REMOTE_VERSION (commit: ${REMOTE_COMMIT:0:8})"

# 5. 比较版本
NEED_UPDATE=false

if [ "$CURRENT_COMMIT" = "$REMOTE_COMMIT" ]; then
    log "✅ 代码已是最新版本"
    
    # 检查 auto-update.sh 是否刚被修改（可能是旧脚本更新的）
    SCRIPT_MTIME=$(stat -c %Y "$INSTALL_DIR/auto-update.sh" 2>/dev/null || echo 0)
    CURRENT_TIME=$(date +%s)
    TIME_DIFF=$((CURRENT_TIME - SCRIPT_MTIME))
    
    if [ $TIME_DIFF -lt 60 ]; then
        log "⚠️  脚本刚被更新（${TIME_DIFF}秒前），强制执行完整更新流程"
        NEED_UPDATE=true
    else
        log "✅ 无需更新"
        exit 0
    fi
else
    NEED_UPDATE=true
fi

if [ "$NEED_UPDATE" = false ]; then
    exit 0
fi

log ""
log "🆕 发现新版本！"
log "   v$CURRENT_VERSION (${CURRENT_COMMIT:0:8}) → v$REMOTE_VERSION (${REMOTE_COMMIT:0:8})"

# 执行更新
log ""
log "======================================"
log "🚀 开始自动更新..."
log "======================================"

# 6.1 更新代码
log "[1/5] 更新代码..."
git reset --hard origin/master 2>&1 | tee -a $LOG_FILE
git clean -fd >/dev/null 2>&1
log "✅ 代码已更新"

# 6.2 安装依赖
log ""
log "[2/5] 安装依赖..."
npm install --include=dev 2>&1 | tee -a $LOG_FILE
if [ $? -ne 0 ]; then
    log "❌ 依赖安装失败"
    exit 1
fi
log "✅ 依赖已安装"

# 6.3 编译代码
log ""
log "[3/5] 编译代码..."

# 检查 tsc 是否可用
if ! npx tsc --version >/dev/null 2>&1; then
    log "❌ TypeScript 编译器未安装"
    log "   正在安装 TypeScript..."
    npm install --save-dev typescript 2>&1 | tee -a $LOG_FILE
fi

# 执行编译
if npm run build 2>&1 | tee -a $LOG_FILE; then
    # 验证编译输出
    if [ -f "dist/server/index.js" ]; then
        log "✅ 编译成功"
    else
        log "❌ 编译失败：未生成 dist 文件"
        exit 1
    fi
else
    log "❌ 编译失败"
    exit 1
fi

# 6.4 重启服务
log ""
log "[4/5] 重启服务..."
if pm2 describe zeromaps-rpc >/dev/null 2>&1; then
    pm2 restart zeromaps-rpc 2>&1 | tee -a $LOG_FILE
    pm2 save >/dev/null 2>&1
    log "✅ 服务已重启"
else
    log "⚠️  服务未运行，跳过重启"
fi

# 6.5 更新 Caddy 配置
log ""
log "[5/5] 更新 Caddy..."
if command -v caddy &>/dev/null && systemctl is-active caddy >/dev/null 2>&1; then
    # 获取当前域名
    CURRENT_DOMAIN=$(grep -oP '^[a-z0-9.-]+\.zeromaps\.(cn|com\.cn)' /etc/caddy/Caddyfile | head -1)
    
    if [ -n "$CURRENT_DOMAIN" ] && [ -f "$INSTALL_DIR/Caddyfile" ]; then
        # 更新 Caddyfile
        sed "s|{DOMAIN}|$CURRENT_DOMAIN|g" $INSTALL_DIR/Caddyfile > /etc/caddy/Caddyfile
        
        # 重新加载 Caddy
        if systemctl reload caddy >/dev/null 2>&1; then
            log "✅ Caddy 已重新加载"
        else
            log "⚠️  Caddy 重新加载失败"
        fi
    else
        log "⚠️  未找到域名或 Caddyfile，跳过"
    fi
else
    log "ℹ️  Caddy 未运行，跳过"
fi

# 完成
log ""
log "======================================"
log "✅ 更新完成！"
log "======================================"
log "   v$CURRENT_VERSION → v$REMOTE_VERSION"
log ""

# 显示服务状态
if command -v pm2 &>/dev/null; then
    log "📊 服务状态:"
    pm2 list 2>&1 | grep zeromaps | tee -a $LOG_FILE || true
fi

exit 0
