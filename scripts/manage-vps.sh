#!/bin/bash
# VPS管理脚本 - 查看和管理所有VPS

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$SCRIPT_DIR/../configs"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

show_menu() {
  clear
  echo "====================================="
  echo "ZeroMaps RPC VPS 管理面板"
  echo "====================================="
  echo ""
  echo "1. 查看所有VPS配置"
  echo "2. 测试VPS连接"
  echo "3. 查看VPS监控链接"
  echo "4. 生成部署命令"
  echo "5. 添加新VPS配置"
  echo "0. 退出"
  echo ""
  read -p "请选择: " choice
}

list_vps() {
  echo ""
  echo -e "${BLUE}===== VPS配置列表 =====${NC}"
  echo ""
  
  configs=($(ls -1 $CONFIG_DIR/vps-*.conf 2>/dev/null))
  
  if [ ${#configs[@]} -eq 0 ]; then
    echo -e "${RED}✗ 没有找到VPS配置${NC}"
    return
  fi
  
  printf "%-3s %-18s %-30s %-12s %-20s\n" "No" "IPv4地址" "IPv6前缀" "名称" "位置"
  echo "--------------------------------------------------------------------------------"
  
  for i in "${!configs[@]}"; do
    config="${configs[$i]}"
    source "$config"
    printf "%-3s %-18s %-30s %-12s %-20s\n" \
      "$((i+1))" \
      "$LOCAL_IP" \
      "$IPV6_PREFIX" \
      "${SERVER_NAME:-未命名}" \
      "${SERVER_LOCATION:--}"
  done
  
  echo ""
  read -p "按Enter继续..."
}

test_connection() {
  echo ""
  echo -e "${BLUE}===== 测试VPS连接 =====${NC}"
  echo ""
  
  configs=($(ls -1 $CONFIG_DIR/vps-*.conf 2>/dev/null))
  
  for config in "${configs[@]}"; do
    source "$config"
    echo -e "${YELLOW}测试: $LOCAL_IP ($SERVER_NAME)${NC}"
    
    # 测试SSH连接
    if timeout 5 nc -zv $LOCAL_IP 22 2>&1 | grep -q succeeded; then
      echo -e "  SSH:  ${GREEN}✓ 可连接${NC}"
    else
      echo -e "  SSH:  ${RED}✗ 不可达${NC}"
    fi
    
    # 测试RPC端口
    if timeout 5 nc -zv $LOCAL_IP $RPC_PORT 2>&1 | grep -q succeeded; then
      echo -e "  RPC:  ${GREEN}✓ 端口开放${NC}"
    else
      echo -e "  RPC:  ${YELLOW}○ 端口未开放${NC}"
    fi
    
    # 测试监控端口
    if timeout 5 nc -zv $LOCAL_IP $MONITOR_PORT 2>&1 | grep -q succeeded; then
      echo -e "  监控: ${GREEN}✓ 端口开放${NC}"
    else
      echo -e "  监控: ${YELLOW}○ 端口未开放${NC}"
    fi
    
    echo ""
  done
  
  read -p "按Enter继续..."
}

show_monitor_links() {
  echo ""
  echo -e "${BLUE}===== VPS监控链接 =====${NC}"
  echo ""
  
  configs=($(ls -1 $CONFIG_DIR/vps-*.conf 2>/dev/null))
  
  for config in "${configs[@]}"; do
    source "$config"
    echo -e "${GREEN}$SERVER_NAME ($LOCAL_IP)${NC}"
    echo "  监控地址: http://$LOCAL_IP:$MONITOR_PORT"
    echo "  API统计: http://$LOCAL_IP:$MONITOR_PORT/api/stats"
    echo "  API IPv6: http://$LOCAL_IP:$MONITOR_PORT/api/ipv6"
    echo ""
  done
  
  read -p "按Enter继续..."
}

generate_deploy_commands() {
  echo ""
  echo -e "${BLUE}===== 部署命令 =====${NC}"
  echo ""
  
  configs=($(ls -1 $CONFIG_DIR/vps-*.conf 2>/dev/null))
  
  for config in "${configs[@]}"; do
    source "$config"
    config_filename=$(basename "$config")
    echo -e "${GREEN}# $SERVER_NAME ($LOCAL_IP)${NC}"
    echo "ssh root@$LOCAL_IP 'bash -s' < ./scripts/deploy-vps.sh ./configs/$config_filename"
    echo ""
    echo "# 或者在VPS上执行:"
    echo "cd /opt/zeromaps-rpc && git pull && sudo ./scripts/deploy-vps.sh ./configs/$config_filename"
    echo ""
  done
  
  read -p "按Enter继续..."
}

add_new_vps() {
  echo ""
  echo -e "${BLUE}===== 添加新VPS配置 =====${NC}"
  echo ""
  
  bash "$SCRIPT_DIR/create-vps-config.sh"
  
  read -p "按Enter继续..."
}

# 主循环
while true; do
  show_menu
  
  case $choice in
    1) list_vps ;;
    2) test_connection ;;
    3) show_monitor_links ;;
    4) generate_deploy_commands ;;
    5) add_new_vps ;;
    0) echo "退出"; exit 0 ;;
    *) echo -e "${RED}无效选择${NC}"; sleep 1 ;;
  esac
done

