# VPS配置文件目录

此目录存放所有VPS的配置文件，每个文件按VPS的IPv4地址命名。

## 文件命名规范

```
vps-<IPv4地址>.conf
```

例如：
- `vps-107.182.186.123.conf`
- `vps-65.49.194.100.conf`

## 配置文件格式

```bash
# VPS配置文件
# IP: <IPv4地址>
# 名称: <服务器名称>

# IPv6隧道配置
LOCAL_IP="<本地IPv4>"
REMOTE_IP="<隧道远程IP>"
IPV6_PREFIX="<IPv6前缀>"
INTERFACE="ipv6net"

# RPC服务配置
RPC_PORT=9527
MONITOR_PORT=9528
INSTALL_DIR="/opt/zeromaps-rpc"

# 服务器信息
SERVER_NAME="<服务器名称>"
SERVER_LOCATION="<地理位置>"
```

## 当前VPS列表

| No | IPv4地址 | IPv6前缀 | 服务器名称 | 域名 |
|----|---------|---------|-----------|------|
| 1 | 172.93.47.57 | 2607:8700:5500:2943 | tile0 | tile0.zeromaps.com.cn |
| 2 | 65.49.192.85 | 2607:8700:5500:e639 | tile3 | tile3.zeromaps.com.cn |
| 3 | 65.49.195.185 | 2607:8700:5500:1e09 | tile4 | tile4.zeromaps.com.cn |
| 4 | 65.49.194.100 | 2607:8700:5500:203e | tile5 | tile5.zeromaps.cn |
| 5 | 66.112.211.45 | 2607:8700:5500:bf4b | tile6 | tile6.zeromaps.com.cn |
| 6 | 107.182.186.123 | 2607:8700:5500:2043 | tile12 | tile12.zeromaps.com.cn |
| 7 | 45.78.5.252 | 2607:8700:5500:d197 | www | www.zeromaps.com.cn |

### 监控地址

| 服务器 | Web监控 | API统计 |
|-------|---------|---------|
| tile0 | http://tile0.zeromaps.com.cn:9528 | http://tile0.zeromaps.com.cn:9528/api/stats |
| tile3 | http://tile3.zeromaps.com.cn:9528 | http://tile3.zeromaps.com.cn:9528/api/stats |
| tile4 | http://tile4.zeromaps.com.cn:9528 | http://tile4.zeromaps.com.cn:9528/api/stats |
| tile5 | http://tile5.zeromaps.cn:9528 | http://tile5.zeromaps.cn:9528/api/stats |
| tile6 | http://tile6.zeromaps.com.cn:9528 | http://tile6.zeromaps.com.cn:9528/api/stats |
| tile12 | http://tile12.zeromaps.com.cn:9528 | http://tile12.zeromaps.com.cn:9528/api/stats |
| www | http://www.zeromaps.com.cn:9528 | http://www.zeromaps.com.cn:9528/api/stats |

## 使用方法

### 一键部署

在任意VPS上运行一条命令：

```bash
# 直接运行（推荐）
curl -sSL https://raw.githubusercontent.com/vistone/zeromaps-rpc/master/deploy.sh | sudo bash

# 或克隆后运行
git clone https://github.com/vistone/zeromaps-rpc.git /opt/zeromaps-rpc
cd /opt/zeromaps-rpc
sudo ./deploy.sh
```

脚本会自动：
- 检测当前VPS的IP
- 加载对应的配置文件
- 完成所有部署步骤

### 添加新VPS配置

手动创建配置文件：

```bash
# 在configs目录创建新文件
cp configs/vps-107.182.186.123.conf configs/vps-<新IP>.conf

# 编辑配置
vi configs/vps-<新IP>.conf
```

