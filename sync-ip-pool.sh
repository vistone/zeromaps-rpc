#!/bin/bash
# IP 池同步脚本
# 从其他节点拉取最新的 IP 池

set -e

SOURCE_NODE="${1:-tile4.zeromaps.cn}"
SOURCE_URL="https://${SOURCE_NODE}/api/ip-pool"
TARGET_FILE="/opt/zeromaps-rpc/utls-proxy/ip-pools.json"

echo "🔄 从 $SOURCE_NODE 同步 IP 池..."

# 下载 IP 池文件
if curl -s -f -o "${TARGET_FILE}.tmp" "$SOURCE_URL"; then
    # 验证 JSON 格式
    if jq empty "${TARGET_FILE}.tmp" 2>/dev/null; then
        mv "${TARGET_FILE}.tmp" "$TARGET_FILE"
        echo "✅ IP 池同步成功"
        
        # 重启 uTLS 代理以加载新 IP 池
        if command -v pm2 &>/dev/null; then
            pm2 restart utls-proxy 2>/dev/null || true
            echo "✅ uTLS 代理已重启"
        fi
    else
        echo "❌ 下载的文件不是有效的 JSON"
        rm -f "${TARGET_FILE}.tmp"
        exit 1
    fi
else
    echo "❌ 下载失败"
    rm -f "${TARGET_FILE}.tmp"
    exit 1
fi

