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

# 检测是否在screen中运行
if [ -z "$STY" ]; then
  echo -e "${YELLOW}提示: 建议在screen中运行，避免SSH超时${NC}"
  echo "  安装screen: apt install screen -y"
  echo "  使用方法: screen -S deploy"
  echo "  退出screen: Ctrl+A 然后按 D"
  echo "  恢复screen: screen -r deploy"
  echo ""
  read -p "继续部署? (y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "取消部署"
    exit 0
  fi
  echo ""
fi

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
echo "测试IPv6连接..."
if curl -6 -s --max-time 5 https://api64.ipify.org &>/dev/null; then
  IPV6_ADDR=$(curl -6 -s --max-time 5 https://api64.ipify.org)
  echo -e "${GREEN}✓ IPv6连接正常: $IPV6_ADDR${NC}"
else
  echo -e "${YELLOW}⚠ IPv6连接测试失败（可能是api64.ipify.org无法访问）${NC}"
  echo "  尝试其他测试..."
  
  # 尝试ping IPv6网关
  if ping6 -c 2 ${IPV6_PREFIX}::1 &>/dev/null; then
    echo -e "${GREEN}✓ IPv6网关可达${NC}"
  else
    echo -e "${YELLOW}⚠ IPv6网关无响应${NC}"
  fi
  
  # 尝试访问Google
  if curl -6 -s --max-time 5 https://www.google.com &>/dev/null; then
    echo -e "${GREEN}✓ IPv6外网连接正常（Google可访问）${NC}"
  else
    echo -e "${YELLOW}⚠ IPv6外网可能受限${NC}"
  fi
  
  # 显示IPv6地址
  IPV6_ADDRS=$(ip -6 addr show dev $INTERFACE | grep "inet6" | head -3)
  echo "  当前IPv6地址:"
  echo "$IPV6_ADDRS" | while read line; do
    echo "    $line"
  done
  
  echo ""
  echo -e "${YELLOW}继续部署（IPv6可能需要手动检查）${NC}"
fi

# ==========================================
# 步骤3: 添加IPv6地址池（100个）
# ==========================================
echo ""
echo -e "${YELLOW}[3/7] 配置IPv6地址池 (100个地址)...${NC}"

# 先检查是否已经配置过
EXISTING_COUNT=$(ip -6 addr show dev $INTERFACE 2>/dev/null | grep "$IPV6_PREFIX" | wc -l)

# 如果已经有90个以上，认为已配置完整（包含主地址::2 + 池地址）
if [ $EXISTING_COUNT -ge 90 ]; then
  echo -e "${GREEN}✓ IPv6地址池已配置完整（共 $EXISTING_COUNT 个），跳过配置${NC}"
else
  echo "批量添加 ${IPV6_PREFIX}::1001-1100 (100个地址)..."
  
  START_TIME=$(date +%s)
  
  # 创建临时脚本快速添加所有地址
  cat > /tmp/add-ipv6.sh << ADDSCRIPT
#!/bin/bash
for i in {1001..1100}; do
  ip -6 addr add ${IPV6_PREFIX}::\$i/128 dev $INTERFACE 2>/dev/null &
done
wait
ADDSCRIPT
  
  chmod +x /tmp/add-ipv6.sh
  echo "  执行批量添加..."
  /tmp/add-ipv6.sh
  rm -f /tmp/add-ipv6.sh
  
  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))
  
  # 最终统计
  TOTAL_COUNT=$(ip -6 addr show dev $INTERFACE | grep "$IPV6_PREFIX" | wc -l)
  ADDED_COUNT=$((TOTAL_COUNT - EXISTING_COUNT))
  
  echo -e "${GREEN}✓ 完成! 新增: $ADDED_COUNT 个IPv6地址${NC}"
  echo "  总耗时: ${DURATION}秒"
  echo -e "${GREEN}✓ 当前IPv6总数: $TOTAL_COUNT${NC}"
fi

if [ $EXISTING_COUNT -lt 90 ] && [ ${TOTAL_COUNT:-0} -lt 50 ]; then
  echo -e "${RED}✗ 警告: IPv6地址池配置不完整${NC}"
  echo "  预期至少100个，实际 ${TOTAL_COUNT:-0} 个"
  exit 1
fi

# ==========================================
# 步骤4: IPv6持久化
# ==========================================
echo ""
echo -e "${YELLOW}[4/7] 配置IPv6持久化...${NC}"

# 检查是否已经配置过systemd服务
if systemctl is-enabled ipv6-pool >/dev/null 2>&1; then
  echo -e "${GREEN}✓ IPv6持久化已配置，跳过${NC}"
else
  echo "创建IPv6持久化配置..."
  
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

for i in {1001..1100}; do
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
fi

# ==========================================
# 步骤5: 安装系统依赖
# ==========================================
echo ""
echo -e "${YELLOW}[5/7] 安装系统依赖...${NC}"

# Node.js
if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
  echo "安装Node.js 18..."
  
  # 先卸载旧版本Node.js
  if dpkg -l | grep -q nodejs; then
    echo "  卸载旧版本Node.js..."
    apt remove -y nodejs libnode72 libnode-dev >/dev/null 2>&1 || true
    apt autoremove -y >/dev/null 2>&1 || true
  fi
  
  echo "  下载NodeSource安装脚本..."
  if curl -fsSL --max-time 30 https://deb.nodesource.com/setup_18.x -o /tmp/setup_nodejs.sh; then
    echo "  执行安装脚本..."
    bash /tmp/setup_nodejs.sh
    echo "  安装Node.js包..."
    apt install -y nodejs
    rm -f /tmp/setup_nodejs.sh
  else
    echo -e "${RED}✗ 下载NodeSource脚本失败${NC}"
    echo "  尝试直接安装nodejs..."
    apt update >/dev/null 2>&1
    apt install -y nodejs npm
  fi
  
  # 验证安装
  if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
    echo -e "${RED}✗ Node.js或npm安装失败${NC}"
    exit 1
  fi
fi

# 验证Node.js和npm
if command -v node &>/dev/null; then
  echo -e "${GREEN}✓ Node.js: $(node -v)${NC}"
else
  echo -e "${RED}✗ Node.js未安装${NC}"
  exit 1
fi

if command -v npm &>/dev/null; then
  echo -e "${GREEN}✓ npm: $(npm -v)${NC}"
else
  echo -e "${RED}✗ npm未安装${NC}"
  exit 1
fi

# pm2
if ! command -v pm2 &>/dev/null; then
  echo "安装pm2..."
  npm install -g pm2
  if command -v pm2 &>/dev/null; then
    echo -e "${GREEN}✓ pm2安装成功: $(pm2 -v)${NC}"
  else
    echo -e "${RED}✗ pm2安装失败${NC}"
    exit 1
  fi
else
  echo -e "${GREEN}✓ pm2已安装: $(pm2 -v)${NC}"
fi

# ==========================================
# 步骤6: 安装 Go 和编译 uTLS 代理
# ==========================================
echo ""
echo -e "${YELLOW}[6/8] 安装 Go 和编译 uTLS 代理...${NC}"

# 检查 Go 是否已安装
if ! command -v go &>/dev/null; then
  echo "安装 Go 1.21.5..."
  
  cd /tmp
  
  # 下载 Go
  if [ ! -f "go1.21.5.linux-amd64.tar.gz" ]; then
    echo "  下载 Go 安装包..."
    wget -q --show-progress https://go.dev/dl/go1.21.5.linux-amd64.tar.gz
  fi
  
  # 解压到 /usr/local
  echo "  安装 Go..."
  sudo tar -C /usr/local -xzf go1.21.5.linux-amd64.tar.gz
  
  # 添加到 PATH
  export PATH=$PATH:/usr/local/go/bin
  echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
  
  # 清理下载文件
  rm -f go1.21.5.linux-amd64.tar.gz
  
  if command -v go &>/dev/null; then
    echo -e "${GREEN}✓ Go 安装成功: $(go version)${NC}"
  else
    echo -e "${RED}✗ Go 安装失败${NC}"
    exit 1
  fi
else
  GO_VERSION=$(go version | awk '{print $3}')
  echo -e "${GREEN}✓ Go 已安装: $GO_VERSION${NC}"
fi

# 编译 uTLS 代理
echo ""
echo "编译 uTLS 代理..."
cd $INSTALL_DIR/utls-proxy

if [ ! -f "build.sh" ]; then
  echo -e "${RED}✗ 未找到 uTLS 代理源代码${NC}"
  exit 1
fi

# 执行编译
bash build.sh

if [ -f "utls-proxy" ]; then
  UTLS_SIZE=$(du -h utls-proxy | cut -f1)
  echo -e "${GREEN}✓ uTLS 代理编译成功 (大小: $UTLS_SIZE)${NC}"
else
  echo -e "${RED}✗ uTLS 代理编译失败${NC}"
  exit 1
fi

# 启动 uTLS 代理（使用 PM2）
echo ""
echo "配置 uTLS 代理服务..."

# 停止旧的 uTLS 代理
pm2 delete utls-proxy 2>/dev/null || true

# 启动 uTLS 代理
pm2 start $INSTALL_DIR/utls-proxy/utls-proxy \
    --name "utls-proxy" \
    --time \
    --max-memory-restart 100M \
    --error "$INSTALL_DIR/logs/utls-error.log" \
    --output "$INSTALL_DIR/logs/utls-out.log"

pm2 save

echo -e "${GREEN}✓ uTLS 代理已启动${NC}"

# 等待代理启动并测试
echo "测试 uTLS 代理..."
sleep 2

if curl -s --max-time 5 "http://localhost:8765/proxy?url=https://www.google.com" > /dev/null 2>&1; then
  echo -e "${GREEN}✓ uTLS 代理测试成功！${NC}"
else
  echo -e "${YELLOW}⚠️  uTLS 代理测试失败，请检查日志: pm2 logs utls-proxy${NC}"
fi

# ==========================================
# 步骤7: 部署RPC服务
# ==========================================
echo ""
echo -e "${YELLOW}[7/8] 部署RPC服务...${NC}"

cd $INSTALL_DIR

# 更新代码
if [ -d ".git" ]; then
  echo "更新代码..."
  git pull
else
  echo -e "${YELLOW}代码目录不是git仓库，跳过更新${NC}"
fi

# 安装依赖（检查是否需要更新）
if [ ! -d "node_modules" ]; then
  echo "安装npm依赖..."
  npm install
else
  echo "更新npm依赖..."
  npm install
fi

# 确保tsx已全局安装（pm2需要）
if ! command -v tsx &>/dev/null; then
  echo "安装tsx..."
  npm install -g tsx
fi
echo -e "${GREEN}✓ tsx已安装${NC}"

# 编译 TypeScript 代码
echo "编译 TypeScript 代码..."
npm run build
if [ $? -eq 0 ]; then
  echo -e "${GREEN}✓ 代码编译成功${NC}"
else
  echo -e "${RED}✗ 代码编译失败${NC}"
  exit 1
fi

# 配置pm2（使用.cjs后缀，因为package.json是type:module）
# 自动配置所有必要的环境变量，无需手动配置
cat > $INSTALL_DIR/ecosystem.config.cjs << PM2_END
module.exports = {
  apps: [{
    name: 'zeromaps-rpc',
    script: 'server/index.ts',
    interpreter: 'tsx',
    env: {
      NODE_ENV: 'production',
      IPV6_PREFIX: '$IPV6_PREFIX',
      FETCHER_TYPE: 'utls',  // 使用 uTLS 代理（完美模拟 Chrome TLS 指纹）
      UTLS_PROXY_PORT: '8765',  // uTLS 代理端口
      UTLS_CONCURRENCY: '10',  // uTLS 并发数
      // 可选：Webhook 密钥（留空则跳过签名验证）
      // WEBHOOK_SECRET: 'your-secret-key'
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

# 清理可能冲突的systemd服务
if systemctl list-units --full --all 2>/dev/null | grep -q "zeromaps-rpc.service"; then
  echo "检测到systemd服务，正在停止..."
  systemctl stop zeromaps-rpc.service >/dev/null 2>&1 || true
  systemctl disable zeromaps-rpc.service >/dev/null 2>&1 || true
  echo -e "${GREEN}✓ 已停止冲突的systemd服务${NC}"
fi

# 检查并释放9527、9528和9530端口
for port in 9527 9528 9530; do
  if netstat -tlnp 2>/dev/null | grep -q ":$port.*LISTEN"; then
    echo "端口 $port 被占用，正在释放..."
    PIDS=$(netstat -tlnp 2>/dev/null | grep ":$port.*LISTEN" | awk '{print $7}' | cut -d'/' -f1 | grep -E "^[0-9]+$")
    if [ -n "$PIDS" ]; then
      for pid in $PIDS; do
        kill -9 $pid 2>/dev/null || true
      done
      sleep 1
      echo -e "${GREEN}✓ 已释放端口 $port${NC}"
    fi
  fi
done

# 检查服务是否已运行
if pm2 describe zeromaps-rpc >/dev/null 2>&1; then
  echo "检测到已有服务，清理旧配置..."
  
  # 停止并删除旧服务
  pm2 stop zeromaps-rpc >/dev/null 2>&1 || true
  pm2 delete zeromaps-rpc >/dev/null 2>&1 || true
  
  # 等待进程完全退出
  sleep 2
  
  echo "使用新配置重新启动..."
  pm2 start ecosystem.config.cjs
  pm2 save
else
  echo "首次启动服务..."
  pm2 start ecosystem.config.cjs
  pm2 save
  # 设置开机启动
  pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
fi

# 验证服务启动
echo "验证服务启动状态..."
sleep 3

# 检查 9527 端口（RPC 服务）
if netstat -tlnp 2>/dev/null | grep -q ":9527.*LISTEN"; then
  echo -e "${GREEN}✓ RPC 服务端口 9527 已启动${NC}"
else
  echo -e "${RED}✗ RPC 服务端口 9527 未启动${NC}"
fi

# 检查 9528 端口（监控服务 + WebSocket）
if netstat -tlnp 2>/dev/null | grep -q ":9528.*LISTEN"; then
  echo -e "${GREEN}✓ 监控服务端口 9528 已启动${NC}"
else
  echo -e "${RED}✗ 监控服务端口 9528 未启动，查看日志: pm2 logs zeromaps-rpc --err${NC}"
fi

# 检查 9530 端口（Webhook 服务）
if netstat -tlnp 2>/dev/null | grep -q ":9530.*LISTEN"; then
  echo -e "${GREEN}✓ Webhook 服务端口 9530 已启动${NC}"
  
  # 测试 Webhook 健康检查
  if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9530/health | grep -q "200"; then
    echo -e "${GREEN}✓ Webhook 服务健康检查通过${NC}"
  else
    echo -e "${YELLOW}⚠ Webhook 服务可能未完全就绪${NC}"
  fi
else
  echo -e "${RED}✗ Webhook 服务端口 9530 未启动${NC}"
fi

# ==========================================
# 检查并更新Caddy配置（如果已安装）
# ==========================================
if command -v caddy &>/dev/null; then
  if systemctl is-active caddy >/dev/null 2>&1; then
    echo ""
    echo -e "${YELLOW}检测到Caddy已安装，正在更新配置...${NC}"
    
    # 不清理证书（避免触发Let's Encrypt速率限制）
    # 只更新配置
    
    # 创建日志目录（如果不存在）
    mkdir -p /var/log/caddy
    
    # 检查caddy用户是否存在
    if id caddy &>/dev/null; then
      chown -R caddy:caddy /var/log/caddy
      touch /var/log/caddy/zeromaps-rpc.log
      chown caddy:caddy /var/log/caddy/zeromaps-rpc.log
      chmod 644 /var/log/caddy/zeromaps-rpc.log
    else
      # caddy用户不存在，使用root
      echo -e "${YELLOW}⚠ caddy用户不存在，使用root权限${NC}"
    fi
    chmod 755 /var/log/caddy
    
    # 重新生成配置
    sed "s|{DOMAIN}|$SERVER_DOMAIN|g" $INSTALL_DIR/Caddyfile > /etc/caddy/Caddyfile
    
    # 验证配置
    if ! caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
      echo -e "${RED}✗ Caddy配置验证失败${NC}"
      caddy validate --config /etc/caddy/Caddyfile
    else
      # reload或restart Caddy
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
    fi
  fi
fi

# ==========================================
# 步骤8: 安装统一管理面板（可选）
# ==========================================
echo ""
echo -e "${YELLOW}[8/8] 是否安装统一管理面板（可在一个页面查看所有节点）?${NC}"
read -p "安装Caddy和管理面板? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo ""
  echo -e "${YELLOW}[额外] 安装Caddy和统一管理面板...${NC}"
  
  # 检查并安装Caddy
  if command -v caddy &>/dev/null; then
    echo -e "${GREEN}✓ Caddy已安装，跳过安装步骤${NC}"
    echo "  将更新配置并重启..."
  else
    echo "安装Caddy..."
  
    apt install -y debian-keyring debian-archive-keyring apt-transport-https >/dev/null 2>&1
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' 2>/dev/null | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' 2>/dev/null | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    apt update >/dev/null 2>&1
    apt install -y caddy >/dev/null 2>&1
    echo -e "${GREEN}✓ Caddy安装成功${NC}"
  fi
  
  # 创建日志目录并设置权限（必须在Caddy安装后，caddy用户才存在）
  echo "配置日志目录..."
  mkdir -p /var/log/caddy
  chown -R caddy:caddy /var/log/caddy
  chmod 755 /var/log/caddy
  # 预创建日志文件并设置权限
  touch /var/log/caddy/zeromaps-rpc.log
  chown caddy:caddy /var/log/caddy/zeromaps-rpc.log
  chmod 644 /var/log/caddy/zeromaps-rpc.log
  echo -e "${GREEN}✓ 日志目录已配置${NC}"
  
  # 生成Caddy配置（从模板文件）
  echo "生成Caddy配置..."
  
  if [ -z "$SERVER_DOMAIN" ]; then
    echo -e "${RED}✗ 配置文件缺少域名${NC}"
    exit 1
  fi
  
  # 从Caddyfile模板生成配置
  sed "s|{DOMAIN}|$SERVER_DOMAIN|g" $INSTALL_DIR/Caddyfile > /etc/caddy/Caddyfile
  
  echo -e "${GREEN}✓ 配置已生成: $SERVER_DOMAIN${NC}"
  echo ""
  echo "Caddy配置内容:"
  cat /etc/caddy/Caddyfile
  echo ""
  
  # 验证配置
  echo "验证Caddy配置..."
  if ! caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    echo -e "${RED}✗ 配置验证失败${NC}"
    caddy validate --config /etc/caddy/Caddyfile
    exit 1
  fi
  echo -e "${GREEN}✓ 配置验证通过${NC}"
  
  # 开放端口
  if command -v ufw &>/dev/null; then
    ufw allow 80/tcp >/dev/null 2>&1
    ufw allow 443/tcp >/dev/null 2>&1
    echo -e "${GREEN}✓ 防火墙端口已开放${NC}"
  fi
  
  # 启动Caddy
  echo "启动Caddy服务..."
  systemctl enable caddy >/dev/null 2>&1
  
  # 先停止可能存在的进程
  systemctl stop caddy >/dev/null 2>&1
  sleep 1
  
  # 检查端口占用
  if netstat -tlnp | grep -q ":443.*LISTEN"; then
    echo -e "${YELLOW}⚠ 443端口被占用，尝试释放...${NC}"
    PIDS=$(lsof -ti:443 2>/dev/null)
    if [ -n "$PIDS" ]; then
      kill -9 $PIDS 2>/dev/null
      sleep 1
    fi
  fi
  
  if netstat -tlnp | grep -q ":80.*LISTEN"; then
    echo -e "${YELLOW}⚠ 80端口被占用，尝试释放...${NC}"
    PIDS=$(lsof -ti:80 2>/dev/null)
    if [ -n "$PIDS" ]; then
      kill -9 $PIDS 2>/dev/null
      sleep 1
    fi
  fi
  
  # 启动Caddy
  systemctl start caddy
  
  # 等待启动
  sleep 3
  
  # 检查状态
  if ! systemctl is-active caddy >/dev/null 2>&1; then
    echo -e "${RED}✗ Caddy启动失败${NC}"
    echo ""
    echo "=== Caddy状态 ==="
    systemctl status caddy --no-pager -l
    echo ""
    echo "=== 最近日志 ==="
    journalctl -u caddy -n 30 --no-pager
    echo ""
    echo "=== 端口占用情况 ==="
    netstat -tlnp | grep -E ":(80|443)"
    exit 1
  fi
  
  echo -e "${GREEN}✓ Caddy服务运行正常${NC}"
  
  # 测试API反向代理
  echo "测试API反向代理..."
  sleep 2
  if curl -k -s -o /dev/null -w "%{http_code}" https://localhost/api/stats | grep -q "200"; then
    echo -e "${GREEN}✓ API反向代理工作正常${NC}"
  else
    echo -e "${YELLOW}⚠ API反向代理测试失败（服务可能刚启动）${NC}"
  fi
  
  echo -e "${GREEN}✓ 统一管理面板已部署${NC}"
  echo ""
  echo -e "${GREEN}访问地址: https://$SERVER_DOMAIN${NC}"
  echo ""
  echo "提示:"
  echo "  - 首次访问可能需要等待10-30秒（Caddy自动获取SSL证书）"
  echo "  - 管理面板会自动显示所有7个VPS节点的状态"
  echo "  - API通过HTTPS反向代理访问（/api/* -> :9528）"
  echo ""
fi

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
echo "  IPv6池: ::1001 ~ ::1100 (100个地址)"
echo ""
echo "服务端口:"
echo "  uTLS代理: 127.0.0.1:8765 (本地代理，模拟 Chrome TLS)"
echo "  RPC服务: 0.0.0.0:$RPC_PORT (TCP)"
echo "  监控服务: 0.0.0.0:$MONITOR_PORT (HTTP API + WebSocket)"
echo "  Webhook服务: 0.0.0.0:9530 (GitHub 自动更新)"
echo ""
echo "访问地址:"
if [ -n "$SERVER_DOMAIN" ]; then
  echo "  单节点监控: http://$SERVER_DOMAIN:$MONITOR_PORT"
  
  # 如果安装了Caddy，显示管理面板地址
  if command -v caddy &>/dev/null && systemctl is-active caddy >/dev/null 2>&1; then
    echo "  统一管理面板: https://$SERVER_DOMAIN"
  fi
fi
echo ""
echo "常用命令:"
echo "  pm2 status              - 查看服务状态（应该有 utls-proxy 和 zeromaps-rpc）"
echo "  pm2 logs utls-proxy     - 查看 uTLS 代理日志"
echo "  pm2 logs zeromaps-rpc   - 查看主服务日志"
echo "  pm2 restart all         - 重启所有服务"
if command -v caddy &>/dev/null; then
  echo "  systemctl status caddy  - 查看Caddy状态"
fi
echo ""
echo "测试命令:"
echo "  # 测试 uTLS 代理"
echo "  curl 'http://localhost:8765/proxy?url=https://www.google.com' -I"
echo ""
echo "  # 测试 IPv6 地址池"
echo "  curl -6 --interface ${IPV6_PREFIX}::1001 https://api64.ipify.org"
echo ""
echo "  # 测试 Webhook 健康检查"
echo "  curl http://127.0.0.1:9530/health"
if [ -n "$SERVER_DOMAIN" ] && command -v caddy &>/dev/null && systemctl is-active caddy >/dev/null 2>&1; then
  echo "  curl https://$SERVER_DOMAIN/webhook -X POST -H 'X-GitHub-Event: ping' -d '{}'"
fi
echo ""
