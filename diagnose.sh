#!/bin/bash
# ZeroMaps RPC 问题诊断脚本

echo "=========================================="
echo "ZeroMaps RPC 诊断工具"
echo "=========================================="
echo ""

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

cd /opt/zeromaps-rpc

echo "1. PM2 服务状态"
echo "----------------------------------------"
pm2 list

echo ""
echo "2. Go Proxy 重启次数检查"
echo "----------------------------------------"
RESTART_COUNT=$(pm2 list | grep utls-proxy | awk '{print $8}')
echo "重启次数: $RESTART_COUNT"

if [ "$RESTART_COUNT" -gt 10 ]; then
    echo -e "${RED}⚠️  警告：重启次数过高！${NC}"
else
    echo -e "${GREEN}✓ 重启次数正常${NC}"
fi

echo ""
echo "3. 日志目录检查"
echo "----------------------------------------"
if [ -d "/opt/zeromaps-rpc/logs" ]; then
    echo -e "${GREEN}✓ 日志目录存在${NC}"
    ls -lh /opt/zeromaps-rpc/logs/ | grep utls
else
    echo -e "${RED}✗ 日志目录不存在${NC}"
    echo "修复: mkdir -p /opt/zeromaps-rpc/logs"
fi

echo ""
echo "4. 端口监听检查"
echo "----------------------------------------"
if ss -tlnp | grep -q 8765; then
    echo -e "${GREEN}✓ Go Proxy 正在监听 8765 端口${NC}"
    ss -tlnp | grep 8765
else
    echo -e "${RED}✗ Go Proxy 没有监听 8765 端口${NC}"
fi

echo ""
echo "5. 系统资源"
echo "----------------------------------------"
echo "内存使用:"
free -h | grep -E "Mem|Swap"

echo ""
echo "Go Proxy 进程:"
ps aux | grep utls-proxy | grep -v grep

echo ""
echo "6. 最近的错误日志"
echo "----------------------------------------"
if [ -f "/opt/zeromaps-rpc/logs/utls-proxy.log" ]; then
    echo "Go Proxy 日志 (最近 10 行):"
    tail -10 /opt/zeromaps-rpc/logs/utls-proxy.log
else
    echo "PM2 日志 (最近 10 行):"
    pm2 logs utls-proxy --lines 10 --nostream
fi

echo ""
echo "7. 配置检查"
echo "----------------------------------------"
echo "并发配置:"
grep -A3 '"utls"' config/default.json

echo ""
echo "8. Go Proxy 健康检查"
echo "----------------------------------------"
HEALTH=$(curl -s --max-time 2 http://127.0.0.1:8765/health 2>&1)
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Go Proxy 健康检查通过${NC}"
    echo "$HEALTH" | jq . 2>/dev/null || echo "$HEALTH"
else
    echo -e "${RED}✗ Go Proxy 健康检查失败${NC}"
    echo "错误: $HEALTH"
fi

echo ""
echo "=========================================="
echo "诊断完成"
echo "=========================================="

