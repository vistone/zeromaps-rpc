#!/bin/bash

# tile12 诊断脚本

echo "=== tile12 诊断脚本 ==="

# 检查当前用户
echo "当前用户: $(whoami)"

# 检查 PM2 状态
echo "=== PM2 状态 ==="
pm2 list

# 检查端口占用
echo "=== 端口占用检查 ==="
netstat -tlnp | grep -E ":(9527|9528|9530|8765)"

# 检查日志目录权限
echo "=== 日志目录权限 ==="
ls -la /opt/zeromaps-rpc/logs/

# 检查配置文件
echo "=== 配置文件检查 ==="
ls -la /opt/zeromaps-rpc/config/

# 检查主机名
echo "=== 主机名 ==="
hostname

# 检查是否有对应的节点配置文件
echo "=== 节点配置文件 ==="
if [ -f "/opt/zeromaps-rpc/config/node-$(hostname).json" ]; then
    echo "找到配置文件: node-$(hostname).json"
    cat "/opt/zeromaps-rpc/config/node-$(hostname).json"
else
    echo "❌ 缺少配置文件: node-$(hostname).json"
fi

# 检查服务是否能手动启动
echo "=== 手动启动测试 ==="
cd /opt/zeromaps-rpc
timeout 10s node dist/src/main.js 2>&1 | head -20

echo "=== 诊断完成 ==="
