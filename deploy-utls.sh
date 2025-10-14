#!/bin/bash
# uTLS 代理部署脚本

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UTLS_DIR="$SCRIPT_DIR/utls-proxy"

echo "======================================"
echo "🚀 部署 uTLS 代理"
echo "======================================"

# 1. 检查 Go 是否安装
if ! command -v go &> /dev/null; then
    echo "❌ 错误: 未安装 Go"
    echo ""
    echo "请先安装 Go:"
    echo "  wget https://go.dev/dl/go1.21.5.linux-amd64.tar.gz"
    echo "  sudo tar -C /usr/local -xzf go1.21.5.linux-amd64.tar.gz"
    echo "  export PATH=\$PATH:/usr/local/go/bin"
    echo "  echo 'export PATH=\$PATH:/usr/local/go/bin' >> ~/.bashrc"
    exit 1
fi

GO_VERSION=$(go version | awk '{print $3}')
echo "✓ Go 已安装: $GO_VERSION"

# 2. 编译 uTLS 代理
echo ""
echo "[1/3] 编译 uTLS 代理..."
cd "$UTLS_DIR"
bash build.sh

# 3. 使用 PM2 管理 uTLS 代理
echo ""
echo "[2/3] 配置 PM2..."

if ! command -v pm2 &> /dev/null; then
    echo "⚠️  警告: 未安装 PM2，将直接运行"
    echo ""
    echo "推荐安装 PM2:"
    echo "  npm install -g pm2"
    echo ""
    echo "手动运行 uTLS 代理:"
    echo "  cd $UTLS_DIR"
    echo "  ./utls-proxy"
    exit 0
fi

# 停止旧的 uTLS 代理进程
pm2 delete utls-proxy 2>/dev/null || true

# 启动 uTLS 代理
pm2 start "$UTLS_DIR/utls-proxy" \
    --name "utls-proxy" \
    --time \
    --no-autorestart

pm2 save

echo "✓ uTLS 代理已启动"

# 4. 等待代理启动
echo ""
echo "[3/3] 等待代理启动..."
sleep 2

# 测试代理是否正常
if curl -s "http://localhost:8765/proxy?url=https://www.google.com" > /dev/null 2>&1; then
    echo "✅ uTLS 代理测试成功！"
else
    echo "⚠️  警告: uTLS 代理可能未正常启动"
    echo "请检查日志: pm2 logs utls-proxy"
fi

echo ""
echo "======================================"
echo "✅ 部署完成"
echo "======================================"
echo "uTLS 代理地址: http://localhost:8765/proxy"
echo "查看日志: pm2 logs utls-proxy"
echo "重启代理: pm2 restart utls-proxy"
echo ""
echo "现在可以部署主服务:"
echo "  sudo bash auto-update.sh"

