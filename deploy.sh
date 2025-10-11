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
if curl -6 -s --max-time 5 https://api64.ipify.org &>/dev/null; then
  IPV6_ADDR=$(curl -6 -s --max-time 5 https://api64.ipify.org)
  echo -e "${GREEN}✓ IPv6连接正常: $IPV6_ADDR${NC}"
else
  echo -e "${RED}✗ IPv6连接失败${NC}"
  exit 1
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

# 配置pm2（使用.cjs后缀，因为package.json是type:module）
cat > $INSTALL_DIR/ecosystem.config.cjs << PM2_END
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

# 检查服务是否已运行
if pm2 describe zeromaps-rpc >/dev/null 2>&1; then
  echo "服务已存在，重启中..."
  pm2 restart zeromaps-rpc
else
  echo "首次启动服务..."
  pm2 start ecosystem.config.cjs
  pm2 save
  # 设置开机启动
  pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
fi

# ==========================================
# 可选: 安装统一管理面板
# ==========================================
echo ""
echo -e "${YELLOW}是否安装统一管理面板（可在一个页面查看所有7个VPS）?${NC}"
read -p "安装Caddy和管理面板? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo ""
  echo -e "${YELLOW}[额外] 安装Caddy和统一管理面板...${NC}"
  
  # 清理并重新安装Caddy
  echo "清理旧的Caddy..."
  
  # 停止Caddy服务
  systemctl stop caddy >/dev/null 2>&1
  systemctl disable caddy >/dev/null 2>&1
  
  # 卸载Caddy
  if command -v caddy &>/dev/null; then
    apt remove --purge -y caddy >/dev/null 2>&1
    echo -e "${GREEN}✓ 已卸载旧版Caddy${NC}"
  fi
  
  # 清理配置
  rm -f /etc/caddy/Caddyfile
  
  # 重新安装Caddy
  echo "重新安装Caddy..."
  apt install -y debian-keyring debian-archive-keyring apt-transport-https >/dev/null 2>&1
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' 2>/dev/null | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' 2>/dev/null | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt update >/dev/null 2>&1
  apt install -y caddy >/dev/null 2>&1
  echo -e "${GREEN}✓ Caddy安装成功${NC}"
  
  # 配置Caddy（使用当前VPS的域名）
  echo "配置Caddy..."
  if [ -n "$SERVER_DOMAIN" ]; then
    # 替换域名占位符
    sed "s/{DOMAIN}/$SERVER_DOMAIN/g" $INSTALL_DIR/Caddyfile > /etc/caddy/Caddyfile
    echo -e "${GREEN}✓ 配置域名: $SERVER_DOMAIN${NC}"
  else
    echo -e "${RED}✗ 配置文件缺少域名，跳过Caddy配置${NC}"
    exit 1
  fi
  
  # 不再使用certbot，让Caddy自动获取证书
  echo "配置自动HTTPS（Caddy会自动获取Let's Encrypt证书）..."
  
  # 配置Caddy（总是重新生成，确保最新）
  echo "配置Caddy..."
  
  # 创建日志目录并设置权限
  mkdir -p /var/log/caddy
  chown -R caddy:caddy /var/log/caddy
  chmod 755 /var/log/caddy
  echo -e "${GREEN}✓ 日志目录已创建${NC}"
  
  # 强制重新生成配置文件
  sed "s|{DOMAIN}|$SERVER_DOMAIN|g" $INSTALL_DIR/Caddyfile > /etc/caddy/Caddyfile
  
  echo "Caddy配置已生成:"
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
echo "  RPC服务: 0.0.0.0:$RPC_PORT"
echo "  单节点监控: 0.0.0.0:$MONITOR_PORT"
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
echo "  pm2 status              - 查看服务状态"
echo "  pm2 logs zeromaps-rpc   - 查看日志"
echo "  pm2 restart zeromaps-rpc - 重启服务"
if command -v caddy &>/dev/null; then
  echo "  systemctl status caddy  - 查看Caddy状态"
fi
echo ""
echo "测试IPv6:"
echo "  curl -6 --interface ${IPV6_PREFIX}::1001 https://api64.ipify.org"
echo ""
