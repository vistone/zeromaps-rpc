#!/bin/bash
# uTLS Proxy 编译脚本

set -e

echo "🔨 编译 uTLS Proxy..."

cd "$(dirname "$0")"

# 检查 Go 是否安装
if ! command -v go &> /dev/null; then
    echo "❌ 错误: 未安装 Go"
    echo "请先安装 Go: https://go.dev/dl/"
    exit 1
fi

# 整理依赖并下载
echo "📦 整理依赖..."
go mod tidy

echo "📦 下载依赖..."
go mod download

# 编译
echo "🔧 编译中..."
go build -ldflags="-s -w" -o utls-proxy main.go

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

