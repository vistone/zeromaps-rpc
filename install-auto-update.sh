#!/bin/bash
# 安装 ZeroMaps RPC 自动更新服务
# 使用 systemd timer 实现定时检查更新

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

INSTALL_DIR="/opt/zeromaps-rpc"

echo "======================================"
echo "ZeroMaps RPC 自动更新安装"
echo "======================================"
echo ""

# 检查 root 权限
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}✗ 需要 root 权限${NC}"
    echo "请使用: sudo $0"
    exit 1
fi

# 检查安装目录
if [ ! -d "$INSTALL_DIR" ]; then
    echo -e "${RED}✗ $INSTALL_DIR 不存在${NC}"
    echo "请先运行 deploy.sh 部署服务"
    exit 1
fi

# 进入目录
cd $INSTALL_DIR

# 清理本地修改，确保后续自动更新能正常工作
echo ""
echo -e "${YELLOW}清理本地修改...${NC}"
git diff > /tmp/zeromaps-install-backup-$(date +%s).patch 2>/dev/null || true
git reset --hard origin/master >/dev/null 2>&1 || git reset --hard HEAD >/dev/null 2>&1
git clean -fd >/dev/null 2>&1
echo -e "${GREEN}✓ 本地修改已清理${NC}"

# 拉取最新代码
echo "拉取最新代码..."
git pull origin master || {
    echo -e "${RED}✗ git pull 失败${NC}"
    exit 1
}
echo -e "${GREEN}✓ 代码已更新到最新版本${NC}"
echo ""

# 选择更新间隔
echo "请选择自动更新间隔:"
echo "  1) 每 5 分钟检查一次（开发环境）"
echo "  2) 每 30 分钟检查一次（测试环境）"
echo "  3) 每 2 小时检查一次（生产环境，推荐）"
echo "  4) 每 6 小时检查一次（稳定环境）"
echo "  5) 每天检查一次（仅定期维护）"
echo ""
read -p "请选择 [1-5] (默认: 3): " choice

case $choice in
    1)
        INTERVAL="*/5 * * * *"
        INTERVAL_DESC="每 5 分钟"
        ;;
    2)
        INTERVAL="*/30 * * * *"
        INTERVAL_DESC="每 30 分钟"
        ;;
    4)
        INTERVAL="0 */6 * * *"
        INTERVAL_DESC="每 6 小时"
        ;;
    5)
        INTERVAL="0 2 * * *"
        INTERVAL_DESC="每天凌晨2点"
        ;;
    *)
        INTERVAL="0 */2 * * *"
        INTERVAL_DESC="每 2 小时"
        ;;
esac

echo ""
echo -e "${YELLOW}将配置自动更新: $INTERVAL_DESC${NC}"
echo ""

# 创建 systemd service
echo "创建 systemd 服务..."

cat > /etc/systemd/system/zeromaps-auto-update.service << 'SERVICE_END'
[Unit]
Description=ZeroMaps RPC Auto Update Service
After=network.target

[Service]
Type=oneshot
WorkingDirectory=/opt/zeromaps-rpc
ExecStart=/bin/bash /opt/zeromaps-rpc/auto-update.sh
StandardOutput=append:/var/log/zeromaps-auto-update.log
StandardError=append:/var/log/zeromaps-auto-update.log
RemainAfterExit=no

[Install]
WantedBy=multi-user.target
SERVICE_END

echo -e "${GREEN}✓ Service 文件已创建${NC}"

# 创建 systemd timer
echo "创建 systemd timer..."

cat > /etc/systemd/system/zeromaps-auto-update.timer << TIMER_END
[Unit]
Description=ZeroMaps RPC Auto Update Timer
Requires=zeromaps-auto-update.service

[Timer]
OnBootSec=5min
OnUnitActiveSec=2h
AccuracySec=1min
Persistent=true

[Install]
WantedBy=timers.target
TIMER_END

echo -e "${GREEN}✓ Timer 文件已创建${NC}"

# 给脚本添加执行权限
chmod +x $INSTALL_DIR/auto-update.sh

# 重载 systemd
echo "重载 systemd..."
systemctl daemon-reload

# 启用并启动 timer
echo "启用自动更新..."
systemctl enable zeromaps-auto-update.timer
systemctl start zeromaps-auto-update.timer

echo ""
echo "======================================"
echo -e "${GREEN}✓ 自动更新安装完成！${NC}"
echo "======================================"
echo ""
echo "配置信息:"
echo "  更新间隔: $INTERVAL_DESC"
echo "  脚本路径: $INSTALL_DIR/auto-update.sh"
echo "  日志文件: /var/log/zeromaps-auto-update.log"
echo ""
echo "管理命令:"
echo "  systemctl status zeromaps-auto-update.timer   # 查看定时器状态"
echo "  systemctl list-timers zeromaps-auto-update.*  # 查看下次运行时间"
echo "  journalctl -u zeromaps-auto-update.service -f # 查看实时日志"
echo "  tail -f /var/log/zeromaps-auto-update.log     # 查看更新日志"
echo ""
echo "手动触发更新:"
echo "  sudo systemctl start zeromaps-auto-update.service"
echo "  或"
echo "  sudo bash $INSTALL_DIR/auto-update.sh"
echo ""
echo "停用自动更新:"
echo "  sudo systemctl stop zeromaps-auto-update.timer"
echo "  sudo systemctl disable zeromaps-auto-update.timer"
echo ""
echo "下次更新时间:"
systemctl list-timers zeromaps-auto-update.timer --no-pager | grep zeromaps
echo ""

