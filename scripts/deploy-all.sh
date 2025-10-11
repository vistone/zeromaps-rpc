#!/bin/bash
# ZeroMaps RPC 统一部署脚本
# 管理所有VPS的部署

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
echo "ZeroMaps RPC 统一部署管理"
echo "====================================="
echo ""

# 列出所有可用的VPS配置
echo -e "${BLUE}可用的VPS配置:${NC}"
echo ""

configs=($(ls -1 $CONFIG_DIR/vps-*.conf 2>/dev/null))

if [ ${#configs[@]} -eq 0 ]; then
  echo -e "${RED}✗ 没有找到VPS配置文件${NC}"
  echo ""
  echo "请先创建配置文件："
  echo "  ./create-vps-config.sh"
  exit 1
fi

# 显示VPS列表
for i in "${!configs[@]}"; do
  config="${configs[$i]}"
  source "$config"
  echo -e "${GREEN}[$((i+1))]${NC} $LOCAL_IP - ${SERVER_NAME:-未命名} (IPv6: $IPV6_PREFIX)"
done

echo ""
echo -e "${BLUE}选项:${NC}"
echo "  [A] 部署所有VPS"
echo "  [数字] 部署指定VPS"
echo "  [Q] 退出"
echo ""

read -p "请选择: " choice

case "$choice" in
  [Aa])
    echo ""
    echo -e "${YELLOW}准备部署所有 ${#configs[@]} 个VPS...${NC}"
    echo ""
    read -p "确认继续? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "取消部署"
      exit 0
    fi
    
    # 部署所有VPS
    for config in "${configs[@]}"; do
      echo ""
      echo "======================================"
      source "$config"
      echo -e "${BLUE}部署: $LOCAL_IP ($SERVER_NAME)${NC}"
      echo "======================================"
      
      bash "$SCRIPT_DIR/deploy-vps.sh" "$config"
      
      if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ $LOCAL_IP 部署成功${NC}"
      else
        echo -e "${RED}✗ $LOCAL_IP 部署失败${NC}"
      fi
    done
    ;;
    
  [Qq])
    echo "退出"
    exit 0
    ;;
    
  *)
    # 检查是否是有效数字
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#configs[@]}" ]; then
      config="${configs[$((choice-1))]}"
      source "$config"
      echo ""
      echo -e "${BLUE}部署: $LOCAL_IP ($SERVER_NAME)${NC}"
      echo ""
      
      bash "$SCRIPT_DIR/deploy-vps.sh" "$config"
    else
      echo -e "${RED}✗ 无效选择${NC}"
      exit 1
    fi
    ;;
esac

