#!/bin/bash
# 创建新VPS配置文件的辅助脚本

echo "====================================="
echo "创建VPS配置文件"
echo "====================================="
echo ""

# 读取配置信息
read -p "VPS本地IPv4地址: " local_ip
read -p "IPv6前缀 (如 2607:8700:5500:203e): " ipv6_prefix
read -p "隧道远程IP (默认: 45.32.66.87): " remote_ip
remote_ip=${remote_ip:-45.32.66.87}

# 验证输入
if [ -z "$local_ip" ] || [ -z "$ipv6_prefix" ]; then
  echo "错误: 本地IP和IPv6前缀不能为空"
  exit 1
fi

# 生成配置文件
CONFIG_FILE="../configs/vps-${local_ip}.conf"

cat > "$CONFIG_FILE" << EOF
# VPS配置文件
# IP: $local_ip
# 创建时间: $(date)

# IPv6隧道配置
LOCAL_IP="$local_ip"
REMOTE_IP="$remote_ip"
IPV6_PREFIX="$ipv6_prefix"
INTERFACE="ipv6net"

# RPC服务配置
RPC_PORT=9527
MONITOR_PORT=9528
INSTALL_DIR="/opt/zeromaps-rpc"

# 服务器信息（可选）
SERVER_NAME="vps-$local_ip"
SERVER_LOCATION=""
EOF

echo ""
echo "✓ 配置文件已创建: $CONFIG_FILE"
echo ""
echo "部署命令:"
echo "  sudo ./deploy-vps.sh $CONFIG_FILE"
echo ""

