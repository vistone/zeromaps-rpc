#!/bin/bash
# ZeroMaps RPC 自动更新脚本
# 采用"停止-同步-重新安装-启动"模式，简单可靠

INSTALL_DIR="/opt/zeromaps-rpc"
LOG_FILE="/var/log/zeromaps-auto-update.log"
REQUIRED_GO_VERSION="1.24.9"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a $LOG_FILE
}

error() {
    log "❌ 错误: $1"
    log "尝试重启服务..."
    pm2 restart all 2>&1 | tee -a $LOG_FILE || true
    exit 1
}

cd $INSTALL_DIR || error "无法进入目录 $INSTALL_DIR"

log "======================================"
log "🚀 开始自动更新（卸载-安装模式）"
log "======================================"

# 第一步：停止所有服务
log "[1/6] 停止所有服务..."
if command -v pm2 >/dev/null 2>&1; then
    pm2 delete all 2>&1 | tee -a $LOG_FILE || true
    log "✓ 所有服务已停止并删除"
else
    log "⚠️  PM2 未安装，跳过"
fi

# 第二步：强制同步最新代码
log "[2/6] 强制同步最新代码..."
git fetch origin master --tags 2>&1 | tee -a $LOG_FILE || error "git fetch 失败"
git reset --hard origin/master 2>&1 | tee -a $LOG_FILE || error "git reset 失败"
CURRENT_VERSION=$(cat package.json | grep '"version"' | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
log "✓ 代码已同步到版本: $CURRENT_VERSION"

# 第三步：检查并升级 Go 版本
log "[3/6] 检查 Go 版本..."
CURRENT_GO_VERSION=""
if [ -f "/usr/local/go/bin/go" ]; then
    CURRENT_GO_VERSION=$(/usr/local/go/bin/go version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
fi

if [ -z "$CURRENT_GO_VERSION" ] || [ "$CURRENT_GO_VERSION" != "$REQUIRED_GO_VERSION" ]; then
    log "⚠️  Go 版本不符合（当前: ${CURRENT_GO_VERSION:-未安装}，需要: $REQUIRED_GO_VERSION）"
    log "下载并安装 Go $REQUIRED_GO_VERSION..."
    
    cd /tmp
    if wget -q --show-progress "https://go.dev/dl/go${REQUIRED_GO_VERSION}.linux-amd64.tar.gz" 2>&1 | tee -a $LOG_FILE; then
        log "✓ Go 下载完成"
        rm -rf /usr/local/go
        tar -C /usr/local -xzf "go${REQUIRED_GO_VERSION}.linux-amd64.tar.gz" 2>&1 | tee -a $LOG_FILE
        
        if /usr/local/go/bin/go version 2>&1 | grep -q "$REQUIRED_GO_VERSION"; then
            log "✅ Go $REQUIRED_GO_VERSION 安装成功"
            rm -f "go${REQUIRED_GO_VERSION}.linux-amd64.tar.gz"
        else
            error "Go 安装失败"
        fi
    else
        error "Go 下载失败"
    fi
    cd $INSTALL_DIR
else
    log "✓ Go 版本正确: $CURRENT_GO_VERSION"
fi

# 第四步：安装 Node.js 依赖
log "[4/6] 安装依赖..."
unset NODE_ENV
npm install 2>&1 | tee -a $LOG_FILE || error "npm install 失败"
log "✓ 依赖安装完成"

# 安装 Git hooks
if [ -d "$INSTALL_DIR/hooks" ]; then
    cp -f $INSTALL_DIR/hooks/* $INSTALL_DIR/.git/hooks/ 2>/dev/null
    chmod +x $INSTALL_DIR/.git/hooks/* 2>/dev/null
    log "✓ Git hooks 已安装"
fi

# 第五步：编译所有代码
log "[5/6] 编译代码..."

# 5.1 编译 TypeScript
if npm run build 2>&1 | tee -a $LOG_FILE; then
    if [ -f "$INSTALL_DIR/dist/server/index.js" ]; then
        log "✓ TypeScript 编译成功"
    else
        error "TypeScript 编译失败：未生成产物"
    fi
else
    error "TypeScript 编译失败"
fi

# 5.2 编译 Go proxy
if [ -f "$INSTALL_DIR/utls-proxy/build.sh" ]; then
    cd $INSTALL_DIR/utls-proxy
    
    if bash build.sh 2>&1 | tee -a $LOG_FILE; then
        if [ -f "utls-proxy" ]; then
            GO_SIZE=$(du -h utls-proxy | cut -f1)
            log "✓ Go proxy 编译成功（$GO_SIZE）"
        else
            error "Go proxy 编译失败：未生成二进制"
        fi
    else
        error "Go proxy 编译失败"
    fi
    cd $INSTALL_DIR
else
    log "⚠️  未找到 Go proxy 构建脚本"
fi

# 第六步：启动所有服务
log "[6/6] 启动所有服务..."

if [ -f "ecosystem.config.cjs" ]; then
    if pm2 start ecosystem.config.cjs 2>&1 | tee -a $LOG_FILE; then
        pm2 save 2>&1 | tee -a $LOG_FILE
        sleep 2
        pm2 list | tee -a $LOG_FILE
        log "✓ 所有服务已启动"
    else
        error "PM2 启动失败"
    fi
else
    error "未找到 ecosystem.config.cjs"
fi

# 验证服务状态
sleep 3
if pm2 list | grep -q "online"; then
    log "✓ 服务运行正常"
    
    # 验证端口
    if ss -tlnp 2>/dev/null | grep -q 8765; then
        log "✓ Go proxy 端口 8765 已监听"
    fi
    
    if curl -s --max-time 2 http://127.0.0.1:8765/health >/dev/null 2>&1; then
        GO_VERSION=$(curl -s http://127.0.0.1:8765/health 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
        log "✓ Go proxy 版本: $GO_VERSION"
    fi
else
    log "⚠️  服务启动异常，请检查日志"
fi

log ""
log "======================================"
log "✅ 更新完成"
log "======================================"
log "版本: $CURRENT_VERSION"

exit 0
