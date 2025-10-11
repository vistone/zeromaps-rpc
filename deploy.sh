#!/bin/bash
# ZeroMaps RPC 一键部署脚本
# 自动检测IP并部署，支持所有已配置的VPS
# 使用方法: curl -sSL https://raw.githubusercontent.com/vistone/zeromaps-rpc/master/deploy.sh | sudo bash

set -e

# 颜色
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "====================================="
echo "ZeroMaps RPC 一键部署"
echo "====================================="
echo ""

# 检测是否从curl管道运行
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "/opt/zeromaps-rpc")"

# 如果目录不存在，先克隆代码
if [ ! -d "$SCRIPT_DIR/configs" ]; then
  echo -e "${YELLOW}克隆代码仓库...${NC}"
  git clone https://github.com/vistone/zeromaps-rpc.git /opt/zeromaps-rpc
  SCRIPT_DIR="/opt/zeromaps-rpc"
  cd $SCRIPT_DIR
fi

CONFIG_DIR="$SCRIPT_DIR/configs"

# 检查root权限
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}✗ 需要root权限${NC}"
  echo "请使用: sudo $0"
  exit 1
fi

# ==========================================
# 自动检测本地IP
# ==========================================
echo -e "${YELLOW}[1/7] 检测本地IP地址...${NC}"

detect_local_ip() {
  # 方法1: 从默认路由获取
  local ip=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+')
  if [ -n "$ip" ] && [[ ! "$ip" =~ ^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.) ]]; then
    echo "$ip"
    return 0
  fi
  
  # 方法2: 从网络接口获取
  for iface in $(ip -o link show | awk -F': ' '{print $2}' | grep -v lo); do
    ip=$(ip addr show $iface | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
    if [ -n "$ip" ] && [[ ! "$ip" =~ ^(10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|192\.168\.) ]]; then
      echo "$ip"
      return 0
    fi
  done
  
  # 方法3: 通过外部API
  ip=$(curl -s --max-time 5 ifconfig.me || curl -s --max-time 5 ipinfo.io/ip)
  if [ -n "$ip" ]; then
    echo "$ip"
    return 0
  fi
  
  return 1
}

LOCAL_IP=$(detect_local_ip)

if [ -z "$LOCAL_IP" ]; then
  echo -e "${RED}✗ 无法检测本地IP地址${NC}"
  exit 1
fi

echo -e "${GREEN}✓ 检测到本地IP: $LOCAL_IP${NC}"

# ==========================================
# 加载对应配置文件
# ==========================================
CONFIG_FILE="$CONFIG_DIR/vps-${LOCAL_IP}.conf"

if [ ! -f "$CONFIG_FILE" ]; then
  echo -e "${RED}✗ 未找到配置文件: vps-${LOCAL_IP}.conf${NC}"
  echo ""
  echo "可用的VPS配置："
  ls -1 $CONFIG_DIR/vps-*.conf 2>/dev/null | while read conf; do
    basename "$conf"
  done
  exit 1
fi

source "$CONFIG_FILE"

echo -e "${GREEN}✓ 加载配置: ${SERVER_NAME:-未命名} (${SERVER_DOMAIN:-无域名})${NC}"
echo ""

# ==========================================
# 步骤2: 配置IPv6隧道
# ==========================================
echo -e "${YELLOW}[2/7] 配置IPv6隧道...${NC}"
if ! ip link show $INTERFACE &>/dev/null; then
  ip tunnel add $INTERFACE mode sit local $LOCAL_IP remote $REMOTE_IP ttl 255
  ip link set $INTERFACE up
  ip addr add ${IPV6_PREFIX}::2/64 dev $INTERFACE
  ip route add ::/0 dev $INTERFACE
  echo -e "${GREEN}✓ IPv6隧道创建成功${NC}"
else
  echo -e "${GREEN}✓ IPv6隧道已存在${NC}"
fi

# 测试IPv6
if curl -6 -s --max-time 5 https://api64.ipify.org &>/dev/null; then
  IPV6_ADDR=$(curl -6 -s --max-time 5 https://api64.ipify.org)
  echo -e "${GREEN}✓ IPv6连接正常: $IPV6_ADDR${NC}"
else
  echo -e "${RED}✗ IPv6连接失败${NC}"
  exit 1
fi

# ==========================================
# 步骤3: 添加IPv6地址池（1000个）
# ==========================================
echo ""
echo -e "${YELLOW}[3/7] 配置IPv6地址池 (1000个地址)...${NC}"

# 先检查是否已经配置过
EXISTING_COUNT=$(ip -6 addr show dev $INTERFACE 2>/dev/null | grep "$IPV6_PREFIX" | wc -l)
echo "检测到已有 $EXISTING_COUNT 个IPv6地址"

if [ $EXISTING_COUNT -ge 1000 ]; then
  echo -e "${GREEN}✓ IPv6地址池已完整配置，跳过${NC}"
else
  echo "开始添加IPv6地址池（大约需要1-2分钟，请耐心等待）..."
  ADDED_COUNT=0
  FAILED_COUNT=0
  START_TIME=$(date +%s)
  
  # 分批添加，每批10个，显示进度
  for batch_start in {1001..2000..10}; do
    batch_end=$((batch_start + 9))
    if [ $batch_end -gt 2000 ]; then
      batch_end=2000
    fi
    
    # 批量添加10个地址
    for i in $(seq $batch_start $batch_end); do
      if ip -6 addr add ${IPV6_PREFIX}::$i/128 dev $INTERFACE 2>/dev/null; then
        ((ADDED_COUNT++))
      else
        ((FAILED_COUNT++))
      fi
    done
    
    # 实时显示进度
    CURRENT=$((batch_end - 1000))
    PERCENT=$((CURRENT * 100 / 1000))
    echo "  [${PERCENT}%] 进度: ${CURRENT}/1000 | 新增: ${ADDED_COUNT} | 已存在: ${FAILED_COUNT}"
  done
  
  echo -e "${GREEN}✓ 完成! 新增: $ADDED_COUNT 个，已存在: $FAILED_COUNT 个${NC}"
  
  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  echo "  总耗时: ${DURATION}秒"
fi

TOTAL_COUNT=$(ip -6 addr show dev $INTERFACE | grep "$IPV6_PREFIX" | wc -l)
echo -e "${GREEN}✓ 当前IPv6总数: $TOTAL_COUNT${NC}"

if [ $TOTAL_COUNT -lt 100 ]; then
  echo -e "${RED}✗ 警告: IPv6地址池配置不完整${NC}"
  echo "  预期至少1000个，实际 $TOTAL_COUNT 个"
  exit 1
fi

# ==========================================
# 步骤4: IPv6持久化
# ==========================================
echo ""
echo -e "${YELLOW}[4/7] 配置IPv6持久化...${NC}"

cat > /root/setup-ipv6-pool.sh << SCRIPT_END
#!/bin/bash
# IPv6配置 - $SERVER_NAME
LOCAL_IP="$LOCAL_IP"
REMOTE_IP="$REMOTE_IP"
IPV6_PREFIX="$IPV6_PREFIX"
INTERFACE="$INTERFACE"

if ! ip link show \$INTERFACE &>/dev/null; then
  ip tunnel add \$INTERFACE mode sit local \$LOCAL_IP remote \$REMOTE_IP ttl 255
  ip link set \$INTERFACE up
  ip addr add \${IPV6_PREFIX}::2/64 dev \$INTERFACE
  ip route add ::/0 dev \$INTERFACE
fi

for i in {1001..2000}; do
  ip -6 addr add \${IPV6_PREFIX}::\$i/128 dev \$INTERFACE 2>/dev/null
done
SCRIPT_END

chmod +x /root/setup-ipv6-pool.sh

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
systemctl enable ipv6-pool >/dev/null 2>&1
echo -e "${GREEN}✓ IPv6持久化配置完成${NC}"

# ==========================================
# 步骤5: 安装系统依赖
# ==========================================
echo ""
echo -e "${YELLOW}[5/7] 安装系统依赖...${NC}"

# Node.js
if ! command -v node &>/dev/null; then
  echo "安装Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash - >/dev/null 2>&1
  apt install -y nodejs >/dev/null 2>&1
fi
echo -e "${GREEN}✓ Node.js: $(node -v)${NC}"

# pm2
if ! command -v pm2 &>/dev/null; then
  echo "安装pm2..."
  npm install -g pm2 >/dev/null 2>&1
fi
echo -e "${GREEN}✓ pm2已安装${NC}"

# ==========================================
# 步骤6: 安装curl-impersonate
# ==========================================
echo ""
echo -e "${YELLOW}[6/7] 安装curl-impersonate...${NC}"

if [ ! -f "/usr/local/bin/curl-impersonate-chrome" ]; then
  cd /tmp
  wget -q --show-progress https://github.com/lwthiker/curl-impersonate/releases/download/v0.6.1/curl-impersonate-v0.6.1.x86_64-linux-gnu.tar.gz
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

# ==========================================
# 步骤7: 部署RPC服务
# ==========================================
echo ""
echo -e "${YELLOW}[7/7] 部署RPC服务...${NC}"

cd $INSTALL_DIR

# 更新代码
if [ -d ".git" ]; then
  echo "更新代码..."
  git pull
else
  echo -e "${YELLOW}代码目录不是git仓库，跳过更新${NC}"
fi

# 安装依赖
echo "安装npm依赖..."
npm install

# 配置pm2
cat > $INSTALL_DIR/ecosystem.config.js << PM2_END
module.exports = {
  apps: [{
    name: 'zeromaps-rpc',
    script: 'server/index.ts',
    interpreter: 'tsx',
    env: {
      NODE_ENV: 'production',
      IPV6_PREFIX: '$IPV6_PREFIX'
    },
    max_memory_restart: '500M',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
}
PM2_END

mkdir -p $INSTALL_DIR/logs

# 启动服务
echo "启动RPC服务..."
pm2 delete zeromaps-rpc 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

# 设置开机启动（静默）
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

echo ""
echo "====================================="
echo -e "${GREEN}✓ 部署完成！${NC}"
echo "====================================="
echo ""
echo "服务器信息:"
echo "  名称: $SERVER_NAME"
if [ -n "$SERVER_DOMAIN" ]; then
  echo "  域名: $SERVER_DOMAIN"
fi
echo "  IPv4: $LOCAL_IP"
echo "  IPv6前缀: $IPV6_PREFIX"
echo "  IPv6池: ::1001 ~ ::2000 (1000个地址)"
echo ""
echo "服务端口:"
echo "  RPC服务: 0.0.0.0:$RPC_PORT"
echo "  Web监控: 0.0.0.0:$MONITOR_PORT"
echo ""
if [ -n "$SERVER_DOMAIN" ]; then
  echo "监控地址:"
  echo "  http://$SERVER_DOMAIN:$MONITOR_PORT"
  echo ""
fi
echo "常用命令:"
echo "  pm2 status              - 查看服务状态"
echo "  pm2 logs zeromaps-rpc   - 查看日志"
echo "  pm2 restart zeromaps-rpc - 重启服务"
echo ""
echo "测试IPv6:"
echo "  curl -6 --interface ${IPV6_PREFIX}::1001 https://api64.ipify.org"
echo ""
