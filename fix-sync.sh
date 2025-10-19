#!/bin/bash
# 紧急修复脚本：用于首次强制同步到最新版本
# 使用场景：当节点因为冲突无法自动更新时使用

echo "======================================"
echo "🔧 紧急修复：强制同步到最新版本"
echo "======================================"

cd /opt/zeromaps-rpc || exit 1

echo "[1/5] 强制同步代码（包括 tags）..."
git fetch origin master --tags
git reset --hard origin/master
echo "✓ 代码已同步"

echo "[2/5] 安装依赖..."
npm install
echo "✓ 依赖已安装"

echo "[3/5] 编译代码..."
npm run build
echo "✓ 编译完成"

echo "[4/5] 编译 Go proxy..."
cd utls-proxy
./build.sh
cd ..
echo "✓ Go proxy 编译完成"

echo "[5/5] 重启所有服务..."
pm2 restart all
sleep 2
pm2 list

echo ""
echo "======================================"
echo "✅ 修复完成"
echo "======================================"

# 显示当前版本
CURRENT_TAG=$(git describe --tags --exact-match HEAD 2>/dev/null || echo "无tag")
echo "当前版本: $CURRENT_TAG"
echo ""
echo "以后更新会自动进行，无需手动操作！"

