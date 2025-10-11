#!/bin/bash
# ZeroMaps RPC 新VPS部署脚本
# VPS IP: 65.49.194.100
# IPv6前缀: 2607:8700:5500:203e

set -e

echo "====================================="
echo "ZeroMaps RPC 新VPS部署"
echo "====================================="

# 配置
LOCAL_IP="65.49.194.100"
REMOTE_IP="45.32.66.87"
IPV6_PREFIX="2607:8700:5500:203e"
INTERFACE="ipv6net"
INSTALL_DIR="/opt/zeromaps-rpc"

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${YELLOW}配置信息:${NC}"
echo "  本地IP: $LOCAL_IP"
echo "  IPv6前缀: $IPV6_PREFIX"
echo "  安装目录: $INSTALL_DIR"
echo ""

# 检查root权限
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}✗ 请使用root权限运行此脚本${NC}"
  echo "  sudo bash deploy-new-vps.sh"
  exit 1
fi

# ==========================================
# 步骤1: 配置IPv6隧道
# ==========================================
echo -e "${YELLOW}[1/6] 配置IPv6隧道...${NC}"
if ! ip link show $INTERFACE &>/dev/null; then
  echo "创建IPv6隧道..."
  ip tunnel add $INTERFACE mode sit local $LOCAL_IP remote $REMOTE_IP ttl 255
  ip link set $INTERFACE up
  ip addr add ${IPV6_PREFIX}::2/64 dev $INTERFACE
  ip route add ::/0 dev $INTERFACE
  echo -e "${GREEN}✓ IPv6隧道创建成功${NC}"
else
  echo -e "${GREEN}✓ IPv6隧道已存在${NC}"
fi

# 测试IPv6连接
echo "测试IPv6连接..."
if curl -6 -s --max-time 5 https://api64.ipify.org &>/dev/null; then
  IPV6_ADDR=$(curl -6 -s --max-time 5 https://api64.ipify.org)
  echo -e "${GREEN}✓ IPv6连接正常: $IPV6_ADDR${NC}"
else
  echo -e "${RED}✗ IPv6连接失败${NC}"
  exit 1
fi

# ==========================================
# 步骤2: 添加IPv6地址池（1000个）
# ==========================================
echo ""
echo -e "${YELLOW}[2/6] 配置IPv6地址池 (1000个地址)...${NC}"
ADDED_COUNT=0
FAILED_COUNT=0

echo "正在添加 ${IPV6_PREFIX}::1001 到 ${IPV6_PREFIX}::2000"
for i in {1001..2000}; do
  if ip -6 addr add ${IPV6_PREFIX}::$i/128 dev $INTERFACE 2>/dev/null; then
    ((ADDED_COUNT++))
  else
    ((FAILED_COUNT++))
  fi
  
  # 每100个显示进度
  if [ $((i % 100)) -eq 0 ]; then
    echo "  进度: $((i - 1000))/1000"
  fi
done

echo -e "${GREEN}✓ 成功添加: $ADDED_COUNT 个${NC}"
if [ $FAILED_COUNT -gt 0 ]; then
  echo -e "${YELLOW}  已存在/失败: $FAILED_COUNT 个${NC}"
fi

# 验证
TOTAL_COUNT=$(ip -6 addr show dev $INTERFACE | grep "$IPV6_PREFIX" | wc -l)
echo -e "${GREEN}✓ 当前IPv6地址总数: $TOTAL_COUNT${NC}"

if [ $TOTAL_COUNT -lt 1000 ]; then
  echo -e "${RED}✗ 警告: IPv6地址池不完整${NC}"
  exit 1
fi

# ==========================================
# 步骤3: IPv6持久化配置
# ==========================================
echo ""
echo -e "${YELLOW}[3/6] 配置IPv6持久化...${NC}"

# 创建启动脚本
cat > /root/setup-ipv6-pool.sh << 'SCRIPT_END'
#!/bin/bash
# IPv6隧道和地址池配置
LOCAL_IP="65.49.194.100"
REMOTE_IP="45.32.66.87"
IPV6_PREFIX="2607:8700:5500:203e"
INTERFACE="ipv6net"

# 配置隧道
if ! ip link show $INTERFACE &>/dev/null; then
  ip tunnel add $INTERFACE mode sit local $LOCAL_IP remote $REMOTE_IP ttl 255
  ip link set $INTERFACE up
  ip addr add ${IPV6_PREFIX}::2/64 dev $INTERFACE
  ip route add ::/0 dev $INTERFACE
fi

# 添加地址池
for i in {1001..2000}; do
  ip -6 addr add ${IPV6_PREFIX}::$i/128 dev $INTERFACE 2>/dev/null
done
SCRIPT_END

chmod +x /root/setup-ipv6-pool.sh

# 创建systemd服务
cat > /etc/systemd/system/ipv6-pool.service << 'SERVICE_END'
[Unit]
Description=IPv6 Tunnel and Address Pool Setup
After=network.target

[Service]
Type=oneshot
ExecStart=/root/setup-ipv6-pool.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
SERVICE_END

systemctl daemon-reload
systemctl enable ipv6-pool
echo -e "${GREEN}✓ IPv6持久化配置完成${NC}"

# ==========================================
# 步骤4: 安装依赖
# ==========================================
echo ""
echo -e "${YELLOW}[4/6] 检查系统依赖...${NC}"

# 检查Node.js
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js未安装${NC}"
  echo "  请先安装: curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt install -y nodejs"
  exit 1
fi
echo -e "${GREEN}✓ Node.js: $(node -v)${NC}"

# 检查npm
if ! command -v npm &>/dev/null; then
  echo -e "${RED}✗ npm未安装${NC}"
  exit 1
fi
echo -e "${GREEN}✓ npm: $(npm -v)${NC}"

# 检查pm2
if ! command -v pm2 &>/dev/null; then
  echo "安装pm2..."
  npm install -g pm2
fi
echo -e "${GREEN}✓ pm2已安装${NC}"

# ==========================================
# 步骤5: 安装curl-impersonate
# ==========================================
echo ""
echo -e "${YELLOW}[5/6] 安装curl-impersonate...${NC}"

if [ ! -f "/usr/local/bin/curl-impersonate-chrome" ]; then
  cd /tmp
  echo "下载curl-impersonate..."
  wget -q --show-progress https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz
  
  echo "解压..."
  tar -xzf curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz
  
  if [ -f "curl_chrome116" ]; then
    cp curl_chrome116 /usr/local/bin/curl-impersonate-chrome
    chmod +x /usr/local/bin/curl-impersonate-chrome
    echo -e "${GREEN}✓ curl-impersonate安装成功${NC}"
  else
    echo -e "${RED}✗ 找不到curl_chrome116${NC}"
    exit 1
  fi
  
  rm -rf curl-impersonate* *.tar.gz
else
  echo -e "${GREEN}✓ curl-impersonate已安装${NC}"
fi

# 测试
/usr/local/bin/curl-impersonate-chrome --version &>/dev/null && echo -e "${GREEN}✓ curl-impersonate测试通过${NC}"

# ==========================================
# 步骤6: 部署RPC服务
# ==========================================
echo ""
echo -e "${YELLOW}[6/6] 部署RPC服务...${NC}"

# 克隆或更新代码
if [ -d "$INSTALL_DIR" ]; then
  echo "更新代码..."
  cd $INSTALL_DIR
  git pull
else
  echo "克隆代码..."
  git clone https://github.com/vistone/zeromaps-rpc.git $INSTALL_DIR
  cd $INSTALL_DIR
fi

# 安装依赖
echo "安装npm依赖..."
npm install

# 配置环境变量
echo "配置环境变量..."
cat > $INSTALL_DIR/.env << ENV_END
IPV6_PREFIX=$IPV6_PREFIX
RPC_PORT=9527
MONITOR_PORT=9528
ENV_END

# 配置pm2
echo "配置pm2..."
cat > $INSTALL_DIR/ecosystem.config.js << 'PM2_END'
module.exports = {
  apps: [{
    name: 'zeromaps-rpc',
    script: 'server/index.ts',
    interpreter: 'tsx',
    env: {
      NODE_ENV: 'production',
      IPV6_PREFIX: '2607:8700:5500:203e'
    },
    max_memory_restart: '500M',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
}
PM2_END

# 创建日志目录
mkdir -p $INSTALL_DIR/logs

# 启动服务
echo "启动RPC服务..."
pm2 start ecosystem.config.js
pm2 save
pm2 startup

echo ""
echo "====================================="
echo -e "${GREEN}✓ 部署完成！${NC}"
echo "====================================="
echo ""
echo "服务信息:"
echo "  RPC服务: 0.0.0.0:9527"
echo "  Web监控: http://65.49.194.100:9528"
echo ""
echo "常用命令:"
echo "  pm2 status          - 查看服务状态"
echo "  pm2 logs zeromaps-rpc  - 查看日志"
echo "  pm2 restart zeromaps-rpc  - 重启服务"
echo ""
echo "测试IPv6:"
echo "  curl -6 --interface ${IPV6_PREFIX}::1001 https://api64.ipify.org"
echo ""

