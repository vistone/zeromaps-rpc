#!/bin/bash

# ==========================================
# ZeroMaps RPC 服务更新脚本
# 用于更新已部署的服务
# ==========================================

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

INSTALL_DIR="/opt/zeromaps-rpc"

echo "====================================="
echo "ZeroMaps RPC 服务更新"
echo "====================================="
echo ""

# 检查是否在正确目录
if [ ! -f "$INSTALL_DIR/package.json" ]; then
  echo -e "${RED}错误: 服务未安装或目录不正确${NC}"
  echo "请先运行 deploy.sh 进行初次部署"
  exit 1
fi

cd $INSTALL_DIR

# 1. 更新代码
echo "[1/4] 更新代码..."
git pull
echo -e "${GREEN}✓ 代码更新完成${NC}"

# 2. 更新依赖
echo ""
echo "[2/4] 更新npm依赖..."
npm install
echo -e "${GREEN}✓ 依赖更新完成${NC}"

# 3. 重启pm2服务
echo ""
echo "[3/4] 重启服务..."

# 清理可能冲突的systemd服务
if systemctl list-units --full --all 2>/dev/null | grep -q "zeromaps-rpc.service"; then
  echo "停止systemd服务..."
  systemctl stop zeromaps-rpc.service >/dev/null 2>&1 || true
  systemctl disable zeromaps-rpc.service >/dev/null 2>&1 || true
  echo -e "${GREEN}✓ 已停止systemd服务${NC}"
fi

# 检查并释放端口
echo "检查端口占用..."
for port in 9527 9528; do
  if netstat -tlnp 2>/dev/null | grep -q ":$port.*LISTEN"; then
    echo "  端口 $port 被占用，正在清理..."
    fuser -k $port/tcp 2>/dev/null || true
    sleep 1
  fi
done
echo -e "${GREEN}✓ 端口检查完成${NC}"

# 重启pm2服务
echo "重启pm2服务..."
if pm2 describe zeromaps-rpc >/dev/null 2>&1; then
  pm2 restart zeromaps-rpc
  echo -e "${GREEN}✓ 服务重启完成${NC}"
else
  echo -e "${RED}✗ pm2服务不存在，请先运行deploy.sh${NC}"
  exit 1
fi

# 等待服务启动
sleep 2
pm2 list

# 4. 更新Caddy配置（如果已安装）
echo ""
echo "[4/4] 更新Caddy配置..."

if command -v caddy &>/dev/null && systemctl is-active caddy >/dev/null 2>&1; then
  # 检测本地IP并加载配置
  LOCAL_IP=$(curl -s -4 ifconfig.me)
  CONFIG_FILE="$INSTALL_DIR/configs/vps-$LOCAL_IP.conf"
  
  if [ -f "$CONFIG_FILE" ]; then
    source $CONFIG_FILE
    
    # 不清理证书（避免Let's Encrypt速率限制）
    
    # 创建日志目录
    mkdir -p /var/log/caddy
    if id caddy &>/dev/null; then
      chown -R caddy:caddy /var/log/caddy 2>/dev/null || true
      touch /var/log/caddy/zeromaps-rpc.log
      chown caddy:caddy /var/log/caddy/zeromaps-rpc.log 2>/dev/null || true
    fi
    chmod 755 /var/log/caddy
    
    # 重新生成配置
    sed "s|{DOMAIN}|$SERVER_DOMAIN|g" $INSTALL_DIR/Caddyfile > /etc/caddy/Caddyfile
    
    # 验证并reload
    if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
      if systemctl reload caddy >/dev/null 2>&1; then
        echo -e "${GREEN}✓ Caddy配置已更新${NC}"
      else
        systemctl restart caddy
        sleep 3
        if systemctl is-active caddy >/dev/null 2>&1; then
          echo -e "${GREEN}✓ Caddy已重启${NC}"
        else
          echo -e "${RED}✗ Caddy启动失败${NC}"
          journalctl -u caddy -n 10 --no-pager
        fi
      fi
    else
      echo -e "${RED}✗ Caddy配置验证失败${NC}"
    fi
  else
    echo -e "${YELLOW}⚠ 未找到配置文件，跳过Caddy更新${NC}"
  fi
else
  echo -e "${YELLOW}⚠ Caddy未安装或未运行，跳过${NC}"
fi

echo ""
echo "====================================="
echo -e "${GREEN}✓ 更新完成！${NC}"
echo "====================================="
echo ""
echo "服务状态:"
pm2 list

echo ""
echo "访问地址:"
if [ -n "$SERVER_DOMAIN" ]; then
  echo "  单节点监控: http://$SERVER_DOMAIN:9528"
  if command -v caddy &>/dev/null && systemctl is-active caddy >/dev/null 2>&1; then
    echo "  统一管理面板: https://$SERVER_DOMAIN"
  fi
fi
echo ""

