#!/bin/bash
# 手动触发所有节点的更新
# 模拟 GitHub Webhook 推送

set -e

echo "🚀 触发所有节点更新..."
echo ""

# 读取节点列表
NODES=(
  "tile0.zeromaps.cn"
  "tile3.zeromaps.cn"
  "tile4.zeromaps.cn"
  "tile5.zeromaps.cn"
  "tile6.zeromaps.cn"
  "tile12.zeromaps.cn"
  "www.zeromaps.com.cn"
)

# 模拟 GitHub push payload
PAYLOAD='{
  "ref": "refs/heads/master",
  "pusher": {"name": "manual-trigger"},
  "commits": [{"message": "手动触发更新"}]
}'

SUCCESS_COUNT=0
FAIL_COUNT=0

for node in "${NODES[@]}"; do
  echo "📡 触发 $node..."
  
  # 发送 webhook（设置超时 10 秒）
  if curl -X POST "https://${node}/webhook" \
      -H "Content-Type: application/json" \
      -H "X-GitHub-Event: push" \
      -d "$PAYLOAD" \
      --max-time 10 \
      -s -o /dev/null -w "%{http_code}" | grep -q "200"; then
    echo "  ✅ $node 更新触发成功"
    SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
  else
    echo "  ❌ $node 更新触发失败"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
  
  # 间隔 1 秒，避免同时更新
  sleep 1
done

echo ""
echo "========================================="
echo "更新触发完成"
echo "  成功: $SUCCESS_COUNT 个节点"
echo "  失败: $FAIL_COUNT 个节点"
echo "========================================="
echo ""
echo "提示："
echo "  - 等待 2-3 分钟让所有节点完成更新"
echo "  - 查看节点状态: https://tile4.zeromaps.cn"
echo "  - 查看节点日志: ssh root@tile4.zeromaps.cn 'pm2 logs zeromaps-rpc --lines 50'"

