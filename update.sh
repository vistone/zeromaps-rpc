#!/bin/bash
# ZeroMaps RPC 统一更新脚本
# 支持手动调用和 Webhook 自动触发

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

INSTALL_DIR="/opt/zeromaps-rpc"
LOG_FILE="/var/log/zeromaps-update.log"

log() {
    echo -e "$1"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> $LOG_FILE
}

log ""
log "====================================="
log "ZeroMaps RPC 服务更新"
log "====================================="

# 检查是否在正确目录
if [ ! -f "$INSTALL_DIR/package.json" ]; then
  log "${RED}错误: 服务未安装或目录不正确${NC}"
  log "请先运行 deploy.sh 进行初次部署"
  exit 1
fi

cd $INSTALL_DIR

# 1. 更新代码（强制同步，不保留本地修改）
log "[1/5] 更新代码..."
git fetch origin master
git reset --hard origin/master
log "${GREEN}✓ 代码更新完成${NC}"

# 2. 更新依赖
log ""
log "[2/5] 更新npm依赖..."
npm install 2>&1 | tee -a $LOG_FILE
log "${GREEN}✓ 依赖更新完成${NC}"

# 3. 编译 TypeScript 代码
log ""
log "[3/5] 编译 TypeScript 代码..."
if npm run build 2>&1 | tee -a $LOG_FILE; then
  log "${GREEN}✓ TypeScript 编译成功${NC}"
else
  log "${RED}✗ TypeScript 编译失败${NC}"
  exit 1
fi

# 3.5. 编译 Go proxy
log ""
log "[3.5/5] 编译 Go proxy..."
cd utls-proxy
if bash build.sh 2>&1 | tee -a $LOG_FILE; then
  log "${GREEN}✓ Go proxy 编译成功${NC}"
else
  log "${RED}✗ Go proxy 编译失败${NC}"
  exit 1
fi
cd ..

# 4. 重启pm2服务
log ""
log "[4/5] 重启服务..."

# 重启所有服务
pm2 restart all 2>&1 | tee -a $LOG_FILE
pm2 save
log "${GREEN}✓ 服务重启完成${NC}"

sleep 2

# 5. 更新Caddy（如果需要）
log ""
log "[5/5] 检查 Caddy..."
if command -v caddy &>/dev/null && systemctl is-active caddy >/dev/null 2>&1; then
  systemctl reload caddy 2>&1 | tee -a $LOG_FILE || true
  log "${GREEN}✓ Caddy 已重新加载${NC}"
else
  log "${YELLOW}⚠ Caddy 未运行，跳过${NC}"
fi

log ""
log "====================================="
log "${GREEN}✓ 更新完成！${NC}"
log "====================================="
log "当前版本: $(cat package.json | grep version | head -1)"
log ""

pm2 list

