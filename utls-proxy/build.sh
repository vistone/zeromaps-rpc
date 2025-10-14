#!/bin/bash
# uTLS Proxy 编译脚本

set -e

echo "🔨 编译 uTLS Proxy..."

cd "$(dirname "$0")"

# 检查 Go 是否安装（智能查找）
GO_BIN=""

# 1. 检查 PATH 中是否有 go
if command -v go &> /dev/null; then
    GO_BIN="go"
# 2. 检查常见安装路径
elif [ -f "/usr/local/go/bin/go" ]; then
    GO_BIN="/usr/local/go/bin/go"
    export PATH=$PATH:/usr/local/go/bin
# 3. 检查用户目录
elif [ -f "$HOME/go/bin/go" ]; then
    GO_BIN="$HOME/go/bin/go"
    export PATH=$PATH:$HOME/go/bin
else
    echo "❌ 错误: 未找到 Go"
    echo "请先安装 Go: https://go.dev/dl/"
    exit 1
fi

GO_VERSION=$($GO_BIN version 2>/dev/null | awk '{print $3}')
echo "✓ 使用 Go: $GO_VERSION ($GO_BIN)"

# 整理依赖并下载
echo "📦 整理依赖..."
$GO_BIN mod tidy

echo "📦 下载依赖..."
$GO_BIN mod download

# 编译
echo "🔧 编译中..."
$GO_BIN build -ldflags="-s -w" -o utls-proxy main.go

# 检查编译结果
if [ -f "utls-proxy" ]; then
    SIZE=$(du -h utls-proxy | cut -f1)
    echo "✅ 编译成功！"
    echo "📁 文件: ./utls-proxy"
    echo "📊 大小: $SIZE"
    echo ""
    echo "运行方式:"
    echo "  ./utls-proxy"
    echo ""
    echo "或指定端口:"
    echo "  UTLS_PROXY_PORT=8765 ./utls-proxy"
else
    echo "❌ 编译失败"
    exit 1
fi

