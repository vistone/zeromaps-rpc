#!/bin/bash
# IPv6地址池配置脚本（1000个地址）
# 用于在服务器上快速配置1000个IPv6地址

set -e

echo "====================================="
echo "IPv6地址池配置（1000个地址）"
echo "====================================="

# 配置参数
IPV6_PREFIX="2607:8700:5500:2043"
LOCAL_IP="107.182.186.123"
REMOTE_IP="45.32.66.87"
INTERFACE="ipv6net"

# 1. 检查并配置IPv6隧道
echo ""
echo "[1/3] 检查IPv6隧道..."
if ! ip link show $INTERFACE &>/dev/null; then
  echo "创建IPv6隧道..."
  ip tunnel add $INTERFACE mode sit local $LOCAL_IP remote $REMOTE_IP ttl 255
  ip link set $INTERFACE up
  ip addr add ${IPV6_PREFIX}::2/64 dev $INTERFACE
  ip route add ::/0 dev $INTERFACE
  echo "✓ IPv6隧道已创建"
else
  echo "✓ IPv6隧道已存在"
fi

# 2. 添加IPv6地址池
echo ""
echo "[2/3] 添加1000个IPv6地址（::1001 到 ::2000）..."
ADDED_COUNT=0
FAILED_COUNT=0

for i in {1001..2000}; do
  if ip -6 addr add ${IPV6_PREFIX}::$i/128 dev $INTERFACE 2>/dev/null; then
    ((ADDED_COUNT++))
  else
    ((FAILED_COUNT++))
  fi
  
  # 每100个显示一次进度
  if [ $((i % 100)) -eq 0 ]; then
    echo "  进度: $((i - 1000))/1000"
  fi
done

echo ""
echo "✓ IPv6地址添加完成"
echo "  成功: $ADDED_COUNT 个"
echo "  已存在/失败: $FAILED_COUNT 个"

# 3. 验证配置
echo ""
echo "[3/3] 验证配置..."
TOTAL_COUNT=$(ip -6 addr show dev $INTERFACE | grep "$IPV6_PREFIX" | wc -l)
echo "✓ 当前IPv6地址总数: $TOTAL_COUNT"

if [ $TOTAL_COUNT -ge 1000 ]; then
  echo ""
  echo "====================================="
  echo "✓ IPv6地址池配置成功！"
  echo "====================================="
  echo "可用地址: ${IPV6_PREFIX}::1001 ~ ${IPV6_PREFIX}::2000"
  echo ""
  echo "测试命令:"
  echo "  curl -6 --interface ${IPV6_PREFIX}::1001 https://api64.ipify.org"
  echo "  curl -6 --interface ${IPV6_PREFIX}::2000 https://api64.ipify.org"
else
  echo ""
  echo "====================================="
  echo "⚠️  警告: IPv6地址池配置不完整"
  echo "====================================="
  echo "预期: 1000+ 个地址"
  echo "实际: $TOTAL_COUNT 个地址"
  echo ""
  echo "可能的原因:"
  echo "  1. 网络接口不存在或未启动"
  echo "  2. IPv6隧道配置错误"
  echo "  3. 权限不足（需要root权限）"
  exit 1
fi

