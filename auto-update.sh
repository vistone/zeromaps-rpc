#!/bin/bash
# ZeroMaps RPC 自动更新脚本
# 由 GitHub Webhook 或定时任务触发

INSTALL_DIR="/opt/zeromaps-rpc"
LOG_FILE="/var/log/zeromaps-auto-update.log"
BACKUP_DIR="/opt/zeromaps-rpc-backup"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a $LOG_FILE
}

error() {
    log "❌ 错误: $1"
    exit 1
}

# 回滚函数
rollback() {
    log "🔄 执行回滚..."
    if [ -d "$BACKUP_DIR" ]; then
        cd $INSTALL_DIR
        git reset --hard $CURRENT_COMMIT 2>&1 | tee -a $LOG_FILE
        
        # 恢复node_modules和dist
        if [ -d "$BACKUP_DIR/node_modules" ]; then
            rm -rf node_modules
            cp -r $BACKUP_DIR/node_modules .
        fi
        if [ -d "$BACKUP_DIR/dist" ]; then
            rm -rf dist
            cp -r $BACKUP_DIR/dist .
        fi
        
        # 重启服务
        if pm2 list | grep -q "online\|stopped"; then
            pm2 restart all 2>&1 | tee -a $LOG_FILE
        fi
        
        log "✅ 回滚完成"
    else
        log "⚠️  备份不存在，无法回滚"
    fi
    exit 1
}

cd $INSTALL_DIR || error "无法进入目录 $INSTALL_DIR"

log "======================================"
log "🔍 检查更新"
log "======================================"

# 记录当前版本
CURRENT_COMMIT=$(git rev-parse HEAD)
log "当前: ${CURRENT_COMMIT:0:8}"

# 获取远程更新
log "获取远程更新..."
if ! git fetch origin master 2>&1 | tee -a $LOG_FILE; then
    error "git fetch 失败"
fi

REMOTE_COMMIT=$(git rev-parse origin/master)
log "远程: ${REMOTE_COMMIT:0:8}"

# 比较
if [ "$CURRENT_COMMIT" = "$REMOTE_COMMIT" ]; then
    log "✅ 已是最新版本，但仍然重启服务以确保代码生效"
    
    # 即使是最新版本，也重启PM2（因为可能代码已被外部更新）
    if pm2 list | grep -q "online\|stopped"; then
        log "重启所有 PM2 进程..."
        pm2 restart all 2>&1 | tee -a $LOG_FILE
        pm2 save >/dev/null 2>&1
        log "✓ PM2 重启完成"
    fi
    
    # 检查并重载 Caddy
    if systemctl is-active caddy >/dev/null 2>&1; then
        if [ -f "/etc/caddy/Caddyfile" ]; then
            CURRENT_DOMAIN=$(grep -E '^[a-z0-9.-]+\.(zeromaps\.cn|zeromaps\.com\.cn)' /etc/caddy/Caddyfile | head -1 | awk '{print $1}')
            if [ -n "$CURRENT_DOMAIN" ]; then
                log "当前域名: $CURRENT_DOMAIN"
                log "更新 Caddy 配置..."
                sed "s|{DOMAIN}|$CURRENT_DOMAIN|g" Caddyfile > /etc/caddy/Caddyfile.new
                
                if caddy validate --config /etc/caddy/Caddyfile.new 2>&1 | tee -a $LOG_FILE; then
                    mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
                    systemctl reload caddy 2>&1 | tee -a $LOG_FILE
                    log "✓ Caddy 已重载"
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

# 1. 更新代码
log "[1/5] 更新代码..."
if ! git pull origin master 2>&1 | tee -a $LOG_FILE; then
    error "git pull 失败"
fi
log "✓ 代码更新完成"

# 2. 检查依赖变化
log "[2/5] 检查依赖..."
if git diff --name-only ${CURRENT_COMMIT} ${REMOTE_COMMIT} | grep -q "package.json"; then
    log "package.json 有变化，安装依赖..."
    if ! npm install 2>&1 | tee -a $LOG_FILE; then
        rollback
    fi
    log "✓ 依赖安装完成"
else
    log "✓ 依赖无变化，跳过安装"
fi

# 3. 编译（如果需要）
log "[3/5] 编译代码..."

# 检查PM2是否使用tsx运行（直接运行TS，不需要编译）
PM2_INTERPRETER=$(pm2 jlist 2>/dev/null | grep -o '"interpreter":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ "$PM2_INTERPRETER" = "tsx" ]; then
    log "✓ 使用 tsx 运行，跳过编译"
elif command -v tsc &> /dev/null; then
    # 有 tsc 命令，执行编译
    if ! npm run build 2>&1 | tee -a $LOG_FILE; then
        log "❌ 编译失败"
        rollback
    fi
    
    # 检查 dist 目录是否存在
    if [ ! -d "dist" ]; then
        log "❌ 编译失败：dist 目录不存在"
        rollback
    fi
    
    log "✓ 编译完成"
else
    log "⚠️  未找到 tsc 命令，跳过编译（使用运行时 TypeScript）"
fi

# 4. 重启PM2服务
log "[4/5] 重启服务..."

if pm2 list | grep -q "online\|stopped"; then
    log "重启所有 PM2 进程..."
    if ! pm2 restart all 2>&1 | tee -a $LOG_FILE; then
        log "❌ PM2 重启失败"
        rollback
    fi
    pm2 save >/dev/null 2>&1
    log "✓ 服务重启完成"
else
    log "⚠️  未找到 PM2 进程，跳过重启"
fi

# 5. 更新Caddy配置（如果需要）
log "[5/5] 检查Caddy配置..."
if systemctl is-active caddy >/dev/null 2>&1; then
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
                    systemctl reload caddy 2>&1 | tee -a $LOG_FILE
                    log "✓ Caddy配置已更新"
                else
                    log "⚠️  Caddy配置验证失败，保持原配置"
                    rm -f /etc/caddy/Caddyfile.new
                fi
            else
                log "✓ Caddy配置无变化"
            fi
        fi
    fi
else
    log "✓ Caddy未运行，跳过"
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
log "版本: ${CURRENT_COMMIT:0:8} -> ${REMOTE_COMMIT:0:8}"

exit 0
