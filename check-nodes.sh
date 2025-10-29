#!/bin/bash

# 检查远程节点状态的脚本

echo "=== 检查远程节点状态 ==="

nodes=(
    "tile0.zeromaps.cn"
    "tile3.zeromaps.cn" 
    "tile4.zeromaps.cn"
    "tile5.zeromaps.cn"
    "tile6.zeromaps.cn"
    "tile12.zeromaps.cn"
    "www.zeromaps.com.cn"
)

for node in "${nodes[@]}"; do
    echo "检查节点: $node"
    
    # 检查 HTTPS API
    echo -n "  HTTPS API: "
    https_status=$(curl -s -o /dev/null -w "%{http_code}" "https://$node/api/stats" --max-time 10)
    echo "$https_status"
    
    # 检查 HTTP API (直接端口)
    echo -n "  HTTP API: "
    http_status=$(curl -s -o /dev/null -w "%{http_code}" "http://$node:9528/api/stats" --max-time 10)
    echo "$http_status"
    
    # 检查端口是否开放
    echo -n "  端口9528: "
    if nc -z "$node" 9528 2>/dev/null; then
        echo "开放"
    else
        echo "关闭"
    fi
    
    echo "---"
done

echo "=== 检查完成 ==="
