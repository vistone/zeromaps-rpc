#!/bin/bash
# 自动检测并部署 - 智能部署脚本
# 无需手动指定配置，自动识别当前VPS并部署

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$SCRIPT_DIR/../configs"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "====================================="
echo "ZeroMaps RPC 智能部署"
echo "====================================="
echo ""

# 检测本地IP地址
echo -e "${YELLOW}[1/2] 检测本地IP地址...${NC}"

# 尝试多种方法获取本地公网IP
detect_local_ip() {
  # 方法1: 从默认路由获取
  local ip=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+')
  if [ -n "$ip" ] && [[ ! "$ip" =~ ^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.) ]]; then
    echo "$ip"
    return 0
  fi
  
  # 方法2: 从网络接口获取（排除内网地址）
  for iface in $(ip -o link show | awk -F': ' '{print $2}' | grep -v lo); do
    ip=$(ip addr show $iface | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
    if [ -n "$ip" ] && [[ ! "$ip" =~ ^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.) ]]; then
      echo "$ip"
      return 0
    fi
  done
  
  # 方法3: 通过外部API获取
  ip=$(curl -s --max-time 5 ifconfig.me || curl -s --max-time 5 icanhazip.com || curl -s --max-time 5 ipinfo.io/ip)
  if [ -n "$ip" ]; then
    echo "$ip"
    return 0
  fi
  
  return 1
}

LOCAL_IP=$(detect_local_ip)

if [ -z "$LOCAL_IP" ]; then
  echo -e "${RED}✗ 无法检测本地IP地址${NC}"
  echo ""
  echo "请手动指定配置文件："
  echo "  sudo ./deploy-vps.sh ../configs/vps-<IP>.conf"
  exit 1
fi

echo -e "${GREEN}✓ 检测到本地IP: $LOCAL_IP${NC}"

# 查找对应的配置文件
echo ""
echo -e "${YELLOW}[2/2] 查找配置文件...${NC}"

CONFIG_FILE="$CONFIG_DIR/vps-${LOCAL_IP}.conf"

if [ ! -f "$CONFIG_FILE" ]; then
  echo -e "${RED}✗ 未找到配置文件: $CONFIG_FILE${NC}"
  echo ""
  echo "当前IP: $LOCAL_IP"
  echo ""
  echo "可用的配置文件："
  ls -1 $CONFIG_DIR/vps-*.conf 2>/dev/null | while read conf; do
    source "$conf"
    echo "  - $LOCAL_IP (${SERVER_NAME:-未命名})"
  done
  echo ""
  echo "请先创建配置文件："
  echo "  ./create-vps-config.sh"
  exit 1
fi

# 加载配置显示信息
source "$CONFIG_FILE"

echo -e "${GREEN}✓ 找到配置文件: $(basename $CONFIG_FILE)${NC}"
echo ""
echo -e "${BLUE}服务器信息:${NC}"
echo "  IP地址: $LOCAL_IP"
echo "  服务器名称: ${SERVER_NAME:-未命名}"
echo "  域名: ${SERVER_DOMAIN:-无}"
echo "  IPv6前缀: $IPV6_PREFIX"
echo ""

# 检查root权限
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}✗ 需要root权限${NC}"
  echo ""
  echo "请使用以下命令运行："
  echo "  sudo $0"
  exit 1
fi

# 确认部署
read -p "确认开始部署? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "取消部署"
  exit 0
fi

# 执行部署
echo ""
echo "====================================="
echo "开始部署..."
echo "====================================="

bash "$SCRIPT_DIR/deploy-vps.sh" "$CONFIG_FILE"

if [ $? -eq 0 ]; then
  echo ""
  echo "====================================="
  echo -e "${GREEN}✓ 部署完成！${NC}"
  echo "====================================="
  echo ""
  echo "服务信息:"
  echo "  RPC服务: 0.0.0.0:$RPC_PORT"
  if [ -n "$SERVER_DOMAIN" ]; then
    echo "  Web监控: http://$SERVER_DOMAIN:$MONITOR_PORT"
  else
    echo "  Web监控: http://$LOCAL_IP:$MONITOR_PORT"
  fi
  echo ""
  echo "常用命令:"
  echo "  pm2 status              - 查看服务状态"
  echo "  pm2 logs zeromaps-rpc   - 查看日志"
  echo "  pm2 restart zeromaps-rpc - 重启服务"
  echo ""
else
  echo ""
  echo -e "${RED}✗ 部署失败${NC}"
  exit 1
fi

