#!/bin/bash
# ZeroMaps RPC 手动更新脚本
# 直接调用 auto-update.sh

INSTALL_DIR="/opt/zeromaps-rpc"

if [ -f "$INSTALL_DIR/auto-update.sh" ]; then
    echo "调用 auto-update.sh 执行更新..."
    bash $INSTALL_DIR/auto-update.sh
else
    echo "错误: 未找到 auto-update.sh"
    exit 1
fi

