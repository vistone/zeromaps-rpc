#!/bin/bash
# 一键部署脚本 - 放在项目根目录，方便快速部署
# 使用方法: curl -sSL https://raw.githubusercontent.com/vistone/zeromaps-rpc/master/deploy.sh | sudo bash

cd "$(dirname "$0")"

# 如果脚本从curl管道运行，先克隆仓库
if [ ! -d "scripts" ]; then
  echo "克隆代码仓库..."
  git clone https://github.com/vistone/zeromaps-rpc.git /opt/zeromaps-rpc
  cd /opt/zeromaps-rpc
fi

# 运行自动部署
bash scripts/auto-deploy.sh

