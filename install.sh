#!/bin/bash

# ZeroMaps RPC 一键安装脚本
# 用于在 VPS 服务器上快速部署 RPC 服务

set -e

echo "======================================"
echo "ZeroMaps RPC 自动安装"
echo "======================================"

# 颜色输出
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 检查参数
if [ -z "$1" ]; then
  echo -e "${RED}错误: 缺少 IPv6 前缀参数${NC}"
  echo "用法: curl -sSL https://raw.githubusercontent.com/vistone/zeromaps-rpc/master/install.sh | bash -s <ipv6-prefix>"
  echo "示例: curl -sSL https://raw.githubusercontent.com/vistone/zeromaps-rpc/master/install.sh | bash -s 2607:8700:5500:2043"
  exit 1
fi

IPV6_PREFIX=$1
INSTALL_DIR="/opt/zeromaps-rpc"

echo ""
echo -e "${YELLOW}配置信息:${NC}"
echo "  IPv6 前缀: $IPV6_PREFIX"
echo "  安装目录: $INSTALL_DIR"
echo "  监听端口: 9527"
echo ""

# 步骤1: 检查系统环境
echo -e "${YELLOW}[1/8] 检查系统环境...${NC}"
if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ Node.js 未安装${NC}"
  echo "  请先安装 Node.js 18+: apt install nodejs npm"
  exit 1
fi
NODE_VERSION=$(node -v)
echo -e "${GREEN}✓ Node.js 已安装: $NODE_VERSION${NC}"

# 步骤2: 安装 curl-impersonate
echo ""
echo -e "${YELLOW}[2/8] 安装 curl-impersonate...${NC}"
if [ ! -f "/usr/local/bin/curl_chrome124" ]; then
  cd /tmp
  echo "  下载中..."
  wget -q --show-progress https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz
  tar -xzf curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz
  
  # 使用 curl_chrome116（最新可用版本）
  if [ -f "curl_chrome116" ]; then
    cp curl_chrome116 /usr/local/bin/curl_chrome116
    chmod +x /usr/local/bin/curl_chrome116
    # 创建符号链接
    ln -sf /usr/local/bin/curl_chrome116 /usr/local/bin/curl_chrome124
    echo -e "${GREEN}✓ 已安装 curl_chrome116${NC}"
  else
    echo -e "${RED}✗ 找不到 curl_chrome116 文件${NC}"
    ls -la | grep curl
    exit 1
  fi
  rm -rf curl-impersonate* *.tar.gz
  echo -e "${GREEN}✓ curl-impersonate 安装完成${NC}"
else
  echo -e "${GREEN}✓ curl-impersonate 已安装${NC}"
fi

# 步骤3: 配置 IPv6 地址池
echo ""
echo -e "${YELLOW}[3/8] 配置 IPv6 地址池 (100个地址)...${NC}"
ADDED_COUNT=0
for i in {1001..1100}; do
  if ip -6 addr add ${IPV6_PREFIX}::$i/128 dev ipv6net 2>/dev/null; then
    ((ADDED_COUNT++))
  fi
done
echo -e "${GREEN}✓ 新添加 $ADDED_COUNT 个 IPv6 地址${NC}"

TOTAL_COUNT=$(ip -6 addr show dev ipv6net 2>/dev/null | grep "${IPV6_PREFIX}" | wc -l)
echo -e "${GREEN}✓ 总计 $TOTAL_COUNT 个 IPv6 地址${NC}"

# 步骤4: 创建 IPv6 持久化脚本
echo ""
echo -e "${YELLOW}[4/8] 创建 IPv6 持久化脚本...${NC}"
cat > /root/setup-ipv6-pool.sh << EOF
#!/bin/bash
for i in {1001..1100}; do
  ip -6 addr add ${IPV6_PREFIX}::\$i/128 dev ipv6net 2>/dev/null
done
EOF
chmod +x /root/setup-ipv6-pool.sh
echo -e "${GREEN}✓ 脚本已创建: /root/setup-ipv6-pool.sh${NC}"

# 步骤5: 下载代码
echo ""
echo -e "${YELLOW}[5/8] 下载 ZeroMaps RPC 代码...${NC}"
if [ -d "$INSTALL_DIR" ]; then
  echo "  目录已存在，正在更新..."
  cd $INSTALL_DIR
  git pull
else
  git clone https://github.com/vistone/zeromaps-rpc.git $INSTALL_DIR
  cd $INSTALL_DIR
fi
echo -e "${GREEN}✓ 代码已下载到 $INSTALL_DIR${NC}"

# 步骤6: 安装依赖
echo ""
echo -e "${YELLOW}[6/8] 安装 Node.js 依赖...${NC}"
npm install --production
echo -e "${GREEN}✓ 依赖安装完成${NC}"

# 步骤7: 编译代码
echo ""
echo -e "${YELLOW}[7/8] 编译 TypeScript 代码...${NC}"
npm run build
echo -e "${GREEN}✓ 编译完成${NC}"

# 步骤8: 创建 systemd 服务
echo ""
echo -e "${YELLOW}[8/8] 创建 systemd 服务...${NC}"
cat > /etc/systemd/system/zeromaps-rpc.service << EOF
[Unit]
Description=ZeroMaps RPC Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
Environment="IPV6_PREFIX=${IPV6_PREFIX}"
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
echo -e "${GREEN}✓ systemd 服务已创建${NC}"

# 测试 IPv6 连通性
echo ""
echo -e "${YELLOW}测试 IPv6 连通性...${NC}"
TEST_IP="${IPV6_PREFIX}::1001"
if curl -6 --interface $TEST_IP -s -m 5 https://api64.ipify.org > /dev/null 2>&1; then
  DETECTED_IP=$(curl -6 --interface $TEST_IP -s -m 5 https://api64.ipify.org)
  echo -e "${GREEN}✓ IPv6 测试成功: $DETECTED_IP${NC}"
else
  echo -e "${RED}✗ IPv6 连通性测试失败${NC}"
  echo "  请检查 IPv6 配置"
fi

# 完成
echo ""
echo "======================================"
echo -e "${GREEN}✓ 安装完成！${NC}"
echo "======================================"
echo ""
echo "服务管理命令:"
echo -e "  ${YELLOW}启动服务:${NC} systemctl start zeromaps-rpc"
echo -e "  ${YELLOW}停止服务:${NC} systemctl stop zeromaps-rpc"
echo -e "  ${YELLOW}查看状态:${NC} systemctl status zeromaps-rpc"
echo -e "  ${YELLOW}查看日志:${NC} journalctl -u zeromaps-rpc -f"
echo ""
echo "测试命令:"
echo -e "  ${YELLOW}测试服务器:${NC} telnet localhost 9527"
echo ""
echo -e "${GREEN}现在可以启动服务: systemctl start zeromaps-rpc${NC}"
echo ""

