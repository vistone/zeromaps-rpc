#!/bin/bash

# ZeroMaps RPC 快速部署脚本
# 用于在 tile2/tile6/tile12 服务器上快速部署 RPC 服务

set -e

echo "======================================"
echo "ZeroMaps RPC 服务器部署"
echo "======================================"

# 检查参数
if [ -z "$1" ]; then
  echo "用法: $0 <ipv6-prefix>"
  echo "示例: $0 2607:8700:5500:2043"
  exit 1
fi

IPV6_PREFIX=$1

echo ""
echo "1. 安装 curl-impersonate..."
if [ ! -f "/usr/local/bin/curl_chrome116" ]; then
  cd /tmp
  wget -q https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz
  tar -xzf curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz
  cp curl_chrome116 /usr/local/bin/
  chmod +x /usr/local/bin/curl_chrome116
  ln -sf /usr/local/bin/curl_chrome116 /usr/local/bin/curl_chrome124
  echo "✓ curl-impersonate 安装完成"
else
  echo "✓ curl-impersonate 已安装"
fi

echo ""
echo "2. 配置 IPv6 地址池..."
# 添加 100 个 IPv6 地址
for i in {1001..1100}; do
  ip -6 addr add ${IPV6_PREFIX}::$i/128 dev ipv6net 2>/dev/null && echo "添加 ${IPV6_PREFIX}::$i" || true
done

# 验证
ADDR_COUNT=$(ip -6 addr show dev ipv6net | grep "${IPV6_PREFIX}" | wc -l)
echo "✓ IPv6 地址池配置完成: $ADDR_COUNT 个地址"

echo ""
echo "3. 创建 IPv6 池持久化脚本..."
cat > /root/setup-ipv6-pool.sh << EOF
#!/bin/bash
for i in {1001..1100}; do
  ip -6 addr add ${IPV6_PREFIX}::\$i/128 dev ipv6net 2>/dev/null
done
echo "✓ IPv6 池已恢复"
EOF

chmod +x /root/setup-ipv6-pool.sh

echo ""
echo "4. 测试 IPv6 连通性..."
TEST_IP="${IPV6_PREFIX}::1001"
if curl -6 --interface $TEST_IP -s https://api64.ipify.org > /dev/null; then
  echo "✓ IPv6 连通性测试成功"
else
  echo "✗ IPv6 连通性测试失败"
  exit 1
fi

echo ""
echo "5. 安装 Node.js 依赖..."
npm install

echo ""
echo "6. 编译 TypeScript..."
npm run build

echo ""
echo "7. 创建 systemd 服务..."
cat > /etc/systemd/system/zeromaps-rpc.service << EOF
[Unit]
Description=ZeroMaps RPC Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$(pwd)
ExecStart=/usr/bin/npm run server
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable zeromaps-rpc

echo ""
echo "======================================"
echo "✓ 部署完成！"
echo "======================================"
echo ""
echo "启动服务: systemctl start zeromaps-rpc"
echo "查看状态: systemctl status zeromaps-rpc"
echo "查看日志: journalctl -u zeromaps-rpc -f"
echo ""

