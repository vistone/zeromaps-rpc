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

# ============ 以下是旧的复杂逻辑（已废弃）============
exit 0

# 比较（旧逻辑）
OLD_LOGIC_START="true"
if [ "$OLD_LOGIC_START" = "false" ]; then
    log "✅ 已是最新版本，但仍然重启服务以确保代码生效"
    
    # 即使是最新版本，也执行环境检查和修复
    log "执行环境检查和日志清理..."
    
    # 确保日志目录存在
    if [ ! -d "$INSTALL_DIR/logs" ]; then
        log "创建日志目录..."
        mkdir -p $INSTALL_DIR/logs
        log "✓ 日志目录已创建"
    fi
    
    # 清理超大的日志文件（防止占满磁盘）
    cd $INSTALL_DIR/logs
    CLEANED_COUNT=0
    TOTAL_SAVED_MB=0
    
    for logfile in utls-error.log utls-out.log zeromaps-error.log zeromaps-out.log out.log error.log combined.log; do
        if [ -f "$logfile" ]; then
            SIZE_MB=$(du -m "$logfile" 2>/dev/null | awk '{print $1}')
            if [ -n "$SIZE_MB" ] && [ "$SIZE_MB" -gt 100 ]; then
                log "⚠️  $logfile 过大 (${SIZE_MB}MB)，清空..."
                echo "" > "$logfile"
                CLEANED_COUNT=$((CLEANED_COUNT + 1))
                TOTAL_SAVED_MB=$((TOTAL_SAVED_MB + SIZE_MB))
                log "✓ 已清空 $logfile"
            fi
        fi
    done
    
    if [ $CLEANED_COUNT -gt 0 ]; then
        log "✓ 日志清理完成：清空 $CLEANED_COUNT 个文件，释放 ${TOTAL_SAVED_MB}MB 空间"
        # 清理日志后重置 PM2 计数器
        if command -v pm2 >/dev/null 2>&1; then
            pm2 reset all >/dev/null 2>&1
            log "✓ 已重置 PM2 重启计数器"
        fi
    else
        log "✓ 所有日志文件大小正常"
    fi
    
    cd $INSTALL_DIR
    
    # 检查 Go proxy 是否需要重新编译
    NEED_GO_REBUILD=false
    
    # 1. 检查重启次数
    if command -v pm2 >/dev/null 2>&1; then
        RESTART_COUNT=$(pm2 list 2>/dev/null | grep utls-proxy | awk '{print $8}' | head -1 | grep -E '^[0-9]+$' || echo "0")
        if [ "$RESTART_COUNT" -gt 20 ] 2>/dev/null; then
            log "⚠️  检测到 Go proxy 重启次数过高 ($RESTART_COUNT)"
            NEED_GO_REBUILD=true
        fi
    fi
    
    # 2. 检查版本号（通过健康检查API）
    if curl -s --max-time 2 http://127.0.0.1:8765/health >/dev/null 2>&1; then
        GO_VERSION=$(curl -s --max-time 2 http://127.0.0.1:8765/health 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
        PACKAGE_VERSION=$(cat $INSTALL_DIR/package.json | grep '"version"' | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
        
        if [ -n "$GO_VERSION" ] && [ -n "$PACKAGE_VERSION" ] && [ "$GO_VERSION" != "$PACKAGE_VERSION" ]; then
            log "⚠️  Go proxy 版本不匹配：Go=$GO_VERSION, Package=$PACKAGE_VERSION"
            NEED_GO_REBUILD=true
        elif [ -z "$GO_VERSION" ]; then
            log "⚠️  无法获取 Go proxy 版本，可能是旧版本"
            NEED_GO_REBUILD=true
        else
            log "✓ Go proxy 版本正确：$GO_VERSION"
        fi
    else
        log "⚠️  Go proxy 未运行或健康检查失败"
        NEED_GO_REBUILD=true
    fi
    
    # 3. 重新编译（如果需要）
    if [ "$NEED_GO_REBUILD" = true ]; then
        if [ -f "$INSTALL_DIR/utls-proxy/build.sh" ]; then
            log "重新编译 Go proxy..."
            cd $INSTALL_DIR/utls-proxy
            if bash build.sh 2>&1 | tee -a $LOG_FILE; then
                log "✓ Go proxy 重新编译成功"
            else
                log "⚠️  Go proxy 重新编译失败"
            fi
            cd $INSTALL_DIR
        fi
        
        # 重置计数器
        if command -v pm2 >/dev/null 2>&1; then
            pm2 reset utls-proxy 2>&1 | tee -a $LOG_FILE || true
        fi
    else
        log "✓ Go proxy 二进制文件正常 (${GO_SIZE_MB}MB)"
    fi
    
    # 即使是最新版本，也重启PM2（因为可能代码已被外部更新或修复）
    if pm2 list | grep -q "online\|stopped"; then
        # 检查是否使用 tsx（需要彻底重启清除缓存）
        PM2_INTERPRETER=$(pm2 jlist 2>/dev/null | grep -o '"interpreter":"[^"]*"' | head -1 | cut -d'"' -f4)
        
        if [ "$PM2_INTERPRETER" = "tsx" ]; then
            log "检测到 tsx 运行模式，彻底重启以清除缓存..."
            rm -rf node_modules/.cache 2>/dev/null || true
            pm2 delete all 2>&1 | tee -a $LOG_FILE
            sleep 1
            if [ -f "ecosystem.config.cjs" ]; then
                pm2 start ecosystem.config.cjs 2>&1 | tee -a $LOG_FILE
            fi
        else
            log "重启所有服务（包括 Go proxy）..."
            pm2 restart all 2>&1 | tee -a $LOG_FILE
        fi
        
        pm2 save >/dev/null 2>&1
        log "✓ 所有服务重启完成"
    fi
    
    # 检查并重启 Caddy
    if systemctl is-active caddy >/dev/null 2>&1; then
        if [ -f "/etc/caddy/Caddyfile" ]; then
            CURRENT_DOMAIN=$(grep -E '^[a-z0-9.-]+\.(zeromaps\.cn|zeromaps\.com\.cn)' /etc/caddy/Caddyfile | head -1 | awk '{print $1}')
            if [ -n "$CURRENT_DOMAIN" ]; then
                log "当前域名: $CURRENT_DOMAIN"
                log "更新 Caddy 配置..."
                sed "s|{DOMAIN}|$CURRENT_DOMAIN|g" Caddyfile > /etc/caddy/Caddyfile.new
                
                if caddy validate --config /etc/caddy/Caddyfile.new 2>&1 | tee -a $LOG_FILE; then
                    mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
                    # 重启 Caddy（而不是 reload）以确保配置完全生效
                    systemctl restart caddy 2>&1 | tee -a $LOG_FILE
                    sleep 2
                    if systemctl is-active caddy >/dev/null 2>&1; then
                        log "✓ Caddy 已重启"
                    else
                        log "❌ Caddy 重启失败"
                    fi
                else
                    log "⚠️  Caddy 配置验证失败，保持原配置"
                    rm -f /etc/caddy/Caddyfile.new
                fi
            fi
        fi
    fi
    
    exit 0
fi

log "🆕 发现更新: ${CURRENT_COMMIT:0:8} -> ${REMOTE_COMMIT:0:8}"

# 执行更新
log ""
log "======================================"
log "🚀 执行更新"
log "======================================"

# 0. 备份当前版本
log "[0/5] 备份当前版本..."
rm -rf $BACKUP_DIR
mkdir -p $BACKUP_DIR
if [ -d "node_modules" ]; then
    cp -r node_modules $BACKUP_DIR/ 2>&1 | tee -a $LOG_FILE
fi
if [ -d "dist" ]; then
    cp -r dist $BACKUP_DIR/ 2>&1 | tee -a $LOG_FILE
fi
log "✓ 备份完成"

# 1. 更新代码（强制同步，不保留本地修改）
log "[1/5] 更新代码..."

# 直接使用强制同步（避免 go.mod/go.sum 冲突，包括 tags）
log "使用强制同步（覆盖本地修改）..."

# 记录更新前的 commit
BEFORE_UPDATE=$CURRENT_COMMIT

if git fetch origin master --tags 2>&1 | tee -a $LOG_FILE; then
    if git reset --hard origin/master 2>&1 | tee -a $LOG_FILE; then
        log "✓ 代码更新完成"
        
        # 检查脚本是否被更新
        AFTER_UPDATE=$(git rev-parse HEAD)
        if [ "$BEFORE_UPDATE" != "$AFTER_UPDATE" ]; then
            log "🔄 脚本已更新，重新执行新版本脚本..."
            exec "$0" "$@"
        fi
    else
        error "git reset 失败"
    fi
else
    error "git fetch 失败"
fi

# 2. 检查 PM2 配置
log "[2/6] 检查 PM2 配置..."
if [ -f "ecosystem.config.cjs" ]; then
    log "✓ PM2 配置文件存在"
else
    log "⚠️  PM2 配置文件不存在，将在重启时自动生成"
fi

# 3. 安装依赖（始终执行，包括 devDependencies）
log "[3/6] 安装依赖..."
# 临时取消 NODE_ENV，确保安装 devDependencies（包括 TypeScript）
SAVED_NODE_ENV=$NODE_ENV
unset NODE_ENV
if ! npm install 2>&1 | tee -a $LOG_FILE; then
    log "❌ 依赖安装失败"
    export NODE_ENV=$SAVED_NODE_ENV
    rollback
fi
export NODE_ENV=$SAVED_NODE_ENV
log "✓ 依赖安装完成"

# 3.1 安装 Git hooks
log "[3.1/6] 安装 Git hooks..."
if [ -d "$INSTALL_DIR/hooks" ]; then
    cp -f $INSTALL_DIR/hooks/* $INSTALL_DIR/.git/hooks/ 2>&1 | tee -a $LOG_FILE
    chmod +x $INSTALL_DIR/.git/hooks/* 2>&1 | tee -a $LOG_FILE
    log "✓ Git hooks 已安装（pre-commit, commit-msg, post-commit）"
else
    log "⚠️  hooks 目录不存在，跳过 Git hooks 安装"
fi

# 3.2 验证 TypeScript 是否已安装
if [ ! -f "$INSTALL_DIR/node_modules/.bin/tsc" ]; then
    log "❌ TypeScript 未安装，尝试手动安装..."
    npm install typescript --save-dev 2>&1 | tee -a $LOG_FILE
    if [ ! -f "$INSTALL_DIR/node_modules/.bin/tsc" ]; then
        log "❌ TypeScript 安装失败"
        rollback
    fi
fi
log "✓ TypeScript 已就绪"

# 4. 编译代码（必须执行）
log "[4/6] 编译代码..."

# 始终执行编译，即使使用 tsx 也需要编译
# 使用临时变量捕获退出码，避免管道影响
set +e  # 暂时允许命令失败
npm run build 2>&1 | tee -a $LOG_FILE
BUILD_EXIT_CODE=${PIPESTATUS[0]}  # 获取 npm run build 的退出码
set -e  # 恢复严格模式

if [ $BUILD_EXIT_CODE -ne 0 ]; then
    log "❌ 编译失败（退出码: $BUILD_EXIT_CODE）"
    rollback
fi

# 二次验证：检查编译产物是否存在
if [ ! -f "$INSTALL_DIR/dist/server/index.js" ]; then
    log "❌ 编译失败：未生成 dist/server/index.js"
    rollback
fi

log "✓ 编译完成"

# 4.1. 检查并升级 Go 版本
log "[4.1/6] 检查 Go 版本..."

REQUIRED_GO_VERSION="1.24.9"
CURRENT_GO_VERSION=""

if [ -f "/usr/local/go/bin/go" ]; then
    CURRENT_GO_VERSION=$(/usr/local/go/bin/go version 2>/dev/null | grep -oE 'go[0-9]+\.[0-9]+\.[0-9]+' | sed 's/go//')
fi

if [ -z "$CURRENT_GO_VERSION" ] || [ "$CURRENT_GO_VERSION" != "$REQUIRED_GO_VERSION" ]; then
    log "⚠️  Go 版本不符合要求（当前: ${CURRENT_GO_VERSION:-未安装}，需要: $REQUIRED_GO_VERSION）"
    log "自动下载并安装 Go $REQUIRED_GO_VERSION..."
    
    cd /tmp
    if wget -q --show-progress "https://go.dev/dl/go${REQUIRED_GO_VERSION}.linux-amd64.tar.gz" 2>&1 | tee -a $LOG_FILE; then
        log "✓ Go 下载完成"
        
        log "安装 Go..."
        rm -rf /usr/local/go
        tar -C /usr/local -xzf "go${REQUIRED_GO_VERSION}.linux-amd64.tar.gz" 2>&1 | tee -a $LOG_FILE
        
        # 验证安装
        if /usr/local/go/bin/go version 2>&1 | grep -q "$REQUIRED_GO_VERSION"; then
            log "✅ Go $REQUIRED_GO_VERSION 安装成功"
            rm -f "go${REQUIRED_GO_VERSION}.linux-amd64.tar.gz"
        else
            log "❌ Go 安装失败"
            rollback
        fi
    else
        log "❌ Go 下载失败"
        rollback
    fi
    
    cd $INSTALL_DIR
else
    log "✓ Go 版本正确：$CURRENT_GO_VERSION"
fi

# 4.2. 编译 Go proxy
log "[4.2/6] 编译 Go proxy..."

if [ -f "$INSTALL_DIR/utls-proxy/build.sh" ]; then
    cd $INSTALL_DIR/utls-proxy
    
    # 记录编译前的时间戳
    BEFORE_COMPILE=$(stat -c %Y "utls-proxy" 2>/dev/null || echo "0")
    
    # 使用 bash 执行编译脚本
    if bash build.sh 2>&1 | tee -a $LOG_FILE; then
        # 验证编译结果：检查文件是否存在且时间戳更新
        AFTER_COMPILE=$(stat -c %Y "utls-proxy" 2>/dev/null || echo "0")
        
        if [ -f "utls-proxy" ] && [ "$AFTER_COMPILE" -gt "$BEFORE_COMPILE" ]; then
            GO_SIZE=$(du -h utls-proxy | cut -f1)
            log "✓ Go proxy 编译成功（大小: $GO_SIZE）"
        else
            log "❌ Go proxy 编译失败：二进制文件未更新"
            rollback
        fi
    else
        log "❌ Go proxy 编译脚本执行失败"
        rollback
    fi
    
    cd $INSTALL_DIR
else
    log "⚠️  未找到 Go proxy 构建脚本，跳过编译"
fi

# 4.3. 环境检查和修复（防止 Go proxy 崩溃）
log "[4.3/6] 环境检查和日志清理..."

# 4.5.1 确保日志目录存在
if [ ! -d "$INSTALL_DIR/logs" ]; then
    log "创建日志目录..."
    mkdir -p $INSTALL_DIR/logs 2>&1 | tee -a $LOG_FILE
    log "✓ 日志目录已创建"
else
    log "✓ 日志目录已存在"
fi

# 4.5.1.1 清理超大的日志文件（防止占满磁盘）
cd $INSTALL_DIR/logs
CLEANED_COUNT=0
TOTAL_SAVED_MB=0

for logfile in utls-error.log utls-out.log zeromaps-error.log zeromaps-out.log out.log error.log combined.log; do
    if [ -f "$logfile" ]; then
        # 获取文件大小（MB）
        SIZE_MB=$(du -m "$logfile" 2>/dev/null | awk '{print $1}')
        if [ -n "$SIZE_MB" ] && [ "$SIZE_MB" -gt 100 ]; then
            log "⚠️  $logfile 过大 (${SIZE_MB}MB)，清空..."
            echo "" > "$logfile"
            CLEANED_COUNT=$((CLEANED_COUNT + 1))
            TOTAL_SAVED_MB=$((TOTAL_SAVED_MB + SIZE_MB))
            log "✓ 已清空 $logfile"
        fi
    fi
done

if [ $CLEANED_COUNT -gt 0 ]; then
    log "✓ 日志清理完成：清空 $CLEANED_COUNT 个文件，释放 ${TOTAL_SAVED_MB}MB 空间"
    # 清理日志后重置 PM2 计数器
    if command -v pm2 >/dev/null 2>&1; then
        pm2 reset all >/dev/null 2>&1
        log "✓ 已重置 PM2 重启计数器"
    fi
else
    log "✓ 所有日志文件大小正常"
fi

cd $INSTALL_DIR

# 4.5.2 检查 Go proxy 重启次数（如果过高，说明有问题）
if command -v pm2 >/dev/null 2>&1; then
    RESTART_COUNT=$(pm2 list 2>/dev/null | grep utls-proxy | awk '{print $8}' | head -1 | grep -E '^[0-9]+$' || echo "0")
    # 确保 RESTART_COUNT 是数字且大于 20
    if [ "$RESTART_COUNT" -gt 20 ] 2>/dev/null; then
        log "⚠️  检测到 Go proxy 重启次数过高 ($RESTART_COUNT)，执行修复..."
        
        # 重新编译 Go proxy（可能是二进制文件有问题）
        if [ -f "$INSTALL_DIR/utls-proxy/build.sh" ]; then
            log "重新编译 Go proxy..."
            cd $INSTALL_DIR/utls-proxy
            if bash build.sh 2>&1 | tee -a $LOG_FILE; then
                log "✓ Go proxy 重新编译成功"
            else
                log "⚠️  Go proxy 重新编译失败"
            fi
            cd $INSTALL_DIR
        fi
        
        # 重置计数器
        pm2 reset utls-proxy 2>&1 | tee -a $LOG_FILE || true
        log "✓ 已重置 Go proxy 重启计数器"
    else
        log "✓ Go proxy 重启次数正常 ($RESTART_COUNT)"
    fi
fi

# 5. 重启PM2服务（重启所有服务以加载最新代码）
log "[4.4/6] 重启所有服务..."

if pm2 list | grep -q "online\|stopped"; then
    # 检查是否使用 tsx（需要彻底重启清除缓存）
    PM2_INTERPRETER=$(pm2 jlist 2>/dev/null | grep -o '"interpreter":"[^"]*"' | head -1 | cut -d'"' -f4)
    
    if [ "$PM2_INTERPRETER" = "tsx" ]; then
        log "检测到 tsx 运行模式，彻底重启以清除缓存..."
        # 清理 node 缓存
        rm -rf node_modules/.cache 2>/dev/null || true
        # 删除所有服务
        pm2 delete all 2>&1 | tee -a $LOG_FILE
        sleep 1
        if [ -f "ecosystem.config.cjs" ]; then
            if ! pm2 start ecosystem.config.cjs 2>&1 | tee -a $LOG_FILE; then
                log "❌ PM2 启动失败"
                rollback
            fi
        else
            log "❌ 未找到 ecosystem.config.cjs"
            rollback
        fi
    else
        log "重启所有服务（包括 Go proxy 加载新二进制）..."
        if ! pm2 restart all 2>&1 | tee -a $LOG_FILE; then
            log "❌ PM2 重启失败"
            rollback
        fi
    fi
    
    pm2 save >/dev/null 2>&1
    log "✓ 所有服务重启完成"
    
    # 5.1 验证服务启动（等待 2 秒后检查）
    sleep 2
    
    # 检查 PM2 状态
    if pm2 list | grep -q "online.*zeromaps-rpc"; then
        log "✓ zeromaps-rpc 启动成功"
    else
        log "⚠️  zeromaps-rpc 启动异常"
    fi
    
    # 检查 Go proxy 端口
    if ss -tlnp 2>/dev/null | grep -q 8765; then
        log "✓ Go proxy 端口 8765 正常监听"
    else
        log "⚠️  Go proxy 端口 8765 未监听，尝试重启..."
        pm2 restart utls-proxy 2>&1 | tee -a $LOG_FILE || true
        sleep 1
    fi
    
    # 健康检查
    if curl -s --max-time 2 http://127.0.0.1:8765/health >/dev/null 2>&1; then
        log "✓ Go proxy 健康检查通过"
    else
        log "⚠️  Go proxy 健康检查失败"
    fi
else
    log "⚠️  未找到 PM2 进程，跳过重启"
fi

# 6. 更新并启动 Caddy（如果已安装）
log "[4.5/6] 检查Caddy配置..."

if command -v caddy &>/dev/null; then
    # Caddy 已安装
    if [ -f "/etc/caddy/Caddyfile" ]; then
        # 提取当前配置的域名
        CURRENT_DOMAIN=$(grep -E '^[a-z0-9.-]+\.(zeromaps\.cn|zeromaps\.com\.cn)' /etc/caddy/Caddyfile | head -1 | awk '{print $1}')
        
        if [ -n "$CURRENT_DOMAIN" ]; then
            log "当前域名: $CURRENT_DOMAIN"
            
            # 检查模板是否变化
            if git diff --name-only ${CURRENT_COMMIT} ${REMOTE_COMMIT} | grep -q "Caddyfile"; then
                log "Caddyfile 模板有变化，更新配置..."
                sed "s|{DOMAIN}|$CURRENT_DOMAIN|g" Caddyfile > /etc/caddy/Caddyfile.new
                
                # 验证新配置
                if caddy validate --config /etc/caddy/Caddyfile.new 2>&1 | tee -a $LOG_FILE; then
                    mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
                    log "✓ Caddy 配置已更新"
                else
                    log "⚠️  Caddy配置验证失败，保持原配置"
                    rm -f /etc/caddy/Caddyfile.new
                fi
            else
                log "✓ Caddy配置无变化"
            fi
            
            # 检查 Caddy 是否运行
            if systemctl is-active caddy >/dev/null 2>&1; then
                log "重启 Caddy..."
                systemctl restart caddy 2>&1 | tee -a $LOG_FILE
                sleep 2
                if systemctl is-active caddy >/dev/null 2>&1; then
                    log "✓ Caddy 已重启"
                else
                    log "❌ Caddy 重启失败"
                    journalctl -u caddy -n 10 --no-pager | tee -a $LOG_FILE
                fi
            else
                log "Caddy 未运行，启动 Caddy..."
                systemctl start caddy 2>&1 | tee -a $LOG_FILE
                sleep 2
                if systemctl is-active caddy >/dev/null 2>&1; then
                    log "✓ Caddy 已启动"
                else
                    log "❌ Caddy 启动失败"
                    journalctl -u caddy -n 10 --no-pager | tee -a $LOG_FILE
                fi
            fi
        else
            log "⚠️  未找到域名配置"
        fi
    else
        log "⚠️  未找到 Caddyfile 配置文件"
    fi
else
    log "✓ Caddy 未安装，跳过"
fi

# 清理备份（保留最近的备份）
log ""
log "清理旧备份..."
rm -rf $BACKUP_DIR
log "✓ 清理完成"

log ""
log "======================================"
log "✅ 更新完成"
log "======================================"
# 显示最终版本和 tag
FINAL_COMMIT=$(git rev-parse HEAD)
FINAL_TAG=$(git describe --tags --exact-match HEAD 2>/dev/null || echo "无tag")
log "版本: ${CURRENT_COMMIT:0:8} ($CURRENT_TAG) -> ${FINAL_COMMIT:0:8} ($FINAL_TAG)"

exit 0
