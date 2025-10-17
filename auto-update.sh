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
        if pm2 list | grep -q "zeromaps-rpc"; then
            pm2 restart zeromaps-rpc 2>&1 | tee -a $LOG_FILE
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
    if pm2 list | grep -q "zeromaps-rpc"; then
        # 检查是否使用 tsx（需要彻底重启清除缓存）
        PM2_INTERPRETER=$(pm2 jlist 2>/dev/null | grep -o '"interpreter":"[^"]*"' | head -1 | cut -d'"' -f4)
        
        if [ "$PM2_INTERPRETER" = "tsx" ]; then
            log "检测到 tsx 运行模式，彻底重启以清除缓存..."
            rm -rf node_modules/.cache 2>/dev/null || true
            pm2 delete zeromaps-rpc 2>&1 | tee -a $LOG_FILE
            sleep 1
            if [ -f "ecosystem.config.cjs" ]; then
                pm2 start ecosystem.config.cjs 2>&1 | tee -a $LOG_FILE
            fi
        else
            log "重启 zeromaps-rpc 进程..."
            pm2 restart zeromaps-rpc 2>&1 | tee -a $LOG_FILE
        fi
        
        pm2 save >/dev/null 2>&1
        log "✓ PM2 重启完成"
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

# 1. 更新代码（处理历史分歧）
log "[1/5] 更新代码..."

# 先尝试正常 pull
if git pull origin master 2>&1 | tee -a $LOG_FILE; then
    log "✓ 代码更新完成（正常拉取）"
else
    # 如果失败，检查是否是历史分歧问题
    if git status 2>&1 | grep -q "divergent\|分歧"; then
        log "⚠️  检测到历史分歧，使用强制同步..."
        # 保存本地未提交的修改（如果有）
        git stash save "auto-update-backup-$(date +%s)" 2>&1 | tee -a $LOG_FILE || true
        # 强制同步远程分支
        if git reset --hard origin/master 2>&1 | tee -a $LOG_FILE; then
            log "✓ 代码强制同步完成"
        else
            error "git reset 失败"
        fi
    else
        error "git pull 失败"
    fi
fi

# 2. 检查 PM2 配置
log "[2/6] 检查 PM2 配置..."
if [ -f "ecosystem.config.cjs" ]; then
    log "✓ PM2 配置文件存在"
else
    log "⚠️  PM2 配置文件不存在，将在重启时自动生成"
fi

# 3. 安装依赖（始终执行）
log "[3/6] 安装依赖..."
if ! npm install 2>&1 | tee -a $LOG_FILE; then
    log "❌ 依赖安装失败"
    rollback
fi
log "✓ 依赖安装完成"

# 4. 编译代码（必须执行）
log "[4/6] 编译代码..."

# 始终执行编译，即使使用 tsx 也需要编译
if ! npm run build 2>&1 | tee -a $LOG_FILE; then
    log "❌ 编译失败"
    rollback
fi

log "✓ 编译完成"

# 4.5. 确保日志目录存在（防止 Go proxy 崩溃）
log "[4.5/6] 检查日志目录..."
if [ ! -d "/var/log/utls-proxy" ]; then
    log "创建 Go proxy 日志目录..."
    if mkdir -p /var/log/utls-proxy 2>&1 | tee -a $LOG_FILE; then
        chmod 755 /var/log/utls-proxy 2>&1 | tee -a $LOG_FILE || true
        log "✓ 日志目录已创建: /var/log/utls-proxy"
    else
        log "⚠️  创建日志目录失败（权限不足），Go proxy 将使用 stdout"
    fi
else
    log "✓ 日志目录已存在"
fi

# 5. 重启PM2服务（彻底重启，清除 tsx 缓存）
log "[5/6] 重启服务..."

if pm2 list | grep -q "online\|stopped"; then
    # 检查是否使用 tsx（需要彻底重启清除缓存）
    PM2_INTERPRETER=$(pm2 jlist 2>/dev/null | grep -o '"interpreter":"[^"]*"' | head -1 | cut -d'"' -f4)
    
    if [ "$PM2_INTERPRETER" = "tsx" ]; then
        log "检测到 tsx 运行模式，彻底重启以清除缓存..."
        # 清理 node 缓存
        rm -rf node_modules/.cache 2>/dev/null || true
        # 只删除 zeromaps-rpc（而不是 all）
        pm2 delete zeromaps-rpc 2>&1 | tee -a $LOG_FILE
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
        log "重启 zeromaps-rpc 进程..."
        if ! pm2 restart zeromaps-rpc 2>&1 | tee -a $LOG_FILE; then
            log "❌ PM2 重启失败"
            rollback
        fi
    fi
    
    pm2 save >/dev/null 2>&1
    log "✓ 服务重启完成"
else
    log "⚠️  未找到 PM2 进程，跳过重启"
fi

# 6. 更新并启动 Caddy（如果已安装）
log "[6/6] 检查Caddy配置..."

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
log "版本: ${CURRENT_COMMIT:0:8} -> ${REMOTE_COMMIT:0:8}"

exit 0
