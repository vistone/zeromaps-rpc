# ZeroMaps RPC 部署指南

> **文档版本**: v2.3.x  
> **更新日期**: 2025-10-20  
> **维护者**: Stone (vistone)

## 📋 目录

- [1. 系统要求](#1-系统要求)
- [2. 初次部署](#2-初次部署)
- [3. 配置管理](#3-配置管理)
- [4. 多节点部署](#4-多节点部署)
- [5. 自动更新](#5-自动更新)
- [6. 监控和运维](#6-监控和运维)
- [7. 故障排查](#7-故障排查)
- [8. 备份和恢复](#8-备份和恢复)

---

## 1. 系统要求

### 1.1 硬件要求

| 组件 | 最低配置 | 推荐配置 | 说明 |
|------|----------|----------|------|
| **CPU** | 2 核 | 4 核 | 并发处理能力 |
| **内存** | 2 GB | 4 GB | Node.js + Go 代理 |
| **磁盘** | 10 GB | 20 GB | 代码 + 日志 + 依赖 |
| **网络** | 100 Mbps | 1 Gbps | 上下行带宽 |

### 1.2 软件要求

| 软件 | 版本 | 必需 | 说明 |
|------|------|------|------|
| **操作系统** | Ubuntu 20.04+ / CentOS 8+ | ✅ | Linux 系统 |
| **Node.js** | 18.x+ | ✅ | JavaScript 运行时 |
| **npm** | 8.x+ | ✅ | 包管理器 |
| **Go** | 1.24.9 | ✅ | Go 编译器 |
| **PM2** | 5.x+ | ✅ | 进程管理 |
| **Git** | 2.x+ | ✅ | 代码管理 |
| **Caddy** | 2.x+ | ❌ | 反向代理（可选）|

### 1.3 网络要求

**必需端口**:
- `9527` - RPC 服务端口（客户端连接）
- `9528` - 监控服务端口（HTTP + WebSocket）
- `9530` - Webhook 端口（GitHub 自动更新）
- `8765` - uTLS 代理端口（内部通信）

**可选端口**:
- `80` / `443` - Caddy 反向代理（HTTPS 访问）

**防火墙规则**:
```bash
# 允许 RPC 端口
sudo ufw allow 9527/tcp

# 允许监控端口
sudo ufw allow 9528/tcp

# 允许 Webhook 端口
sudo ufw allow 9530/tcp

# 可选：Caddy HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

### 1.4 IPv6 要求

**IPv6 隧道**:
- HE (Hurricane Electric) IPv6 隧道
- 其他 IPv6 隧道服务
- 原生 IPv6（如果 VPS 提供商支持）

**IPv6 地址池**:
- 前缀: `/64` 或更大
- 地址数量: 100+ 个（推荐）
- 起始编号: `::1001` ~ `::1100`（可配置）

---

## 2. 初次部署

### 2.1 准备配置文件

#### 2.1.1 创建 VPS 配置文件

在 `configs/` 目录创建对应的配置文件：

```bash
# 检测本地 IP
LOCAL_IP=$(curl -s ifconfig.me)

# 创建配置文件
cat > configs/vps-${LOCAL_IP}.conf <<EOF
# 服务器名称
SERVER_NAME="tile0"

# 服务器域名
SERVER_DOMAIN="tile0.zeromaps.cn"

# IPv6 前缀（如果有）
IPV6_PREFIX="2607:8700:5500:2943"

# IPv6 隧道接口名称
INTERFACE="he-ipv6"

# 远程 IP（用于其他脚本）
REMOTE_IP="${LOCAL_IP}"
EOF
```

**示例配置**:
```bash
# configs/vps-172.93.47.57.conf
SERVER_NAME="tile0"
SERVER_DOMAIN="tile0.zeromaps.cn"
IPV6_PREFIX="2607:8700:5500:2943"
INTERFACE="he-ipv6"
REMOTE_IP="172.93.47.57"
```

**无 IPv6 的配置**:
```bash
# configs/vps-45.82.244.177.conf
SERVER_NAME="tile5"
SERVER_DOMAIN="tile5.zeromaps.cn"
IPV6_PREFIX=""  # 留空表示不使用 IPv6
INTERFACE=""
REMOTE_IP="45.82.244.177"
```

### 2.2 运行部署脚本

```bash
# 1. 克隆代码
git clone https://github.com/vistone/zeromaps-rpc.git /opt/zeromaps-rpc
cd /opt/zeromaps-rpc

# 2. 运行部署脚本（自动检测 IP 并加载配置）
sudo ./deploy.sh
```

### 2.3 部署脚本执行流程

```
[1/10] 检测本地 IP
  - 自动获取: 172.93.47.57

[2/10] 加载配置文件
  - 读取: configs/vps-172.93.47.57.conf
  - IPv6 前缀: 2607:8700:5500:2943
  - 服务器域名: tile0.zeromaps.cn

[3/10] 配置 IPv6 隧道（如果有）
  - 创建接口: he-ipv6
  - 配置地址池: ::1001 ~ ::1100

[4/10] 安装系统依赖
  - Node.js 18.x
  - PM2
  - Go 1.24.9

[5/10] 安装 NPM 依赖
  - npm install
  - 安装 Git hooks

[6/10] 编译 TypeScript
  - npm run build
  - 输出到: dist/

[7/10] 编译 Go uTLS Proxy
  - cd utls-proxy && bash build.sh
  - 输出: utls-proxy/utls-proxy

[8/10] 生成 PM2 配置
  - 自动写入: ecosystem.config.cjs
  - 设置 IPV6_PREFIX 环境变量

[9/10] 启动服务
  - pm2 start utls-proxy（等待 3 秒）
  - pm2 start zeromaps-rpc（等待 3 秒）
  - pm2 save

[10/10] 验证部署
  - 检查端口: 9527, 9528, 9530, 8765
  - 健康检查: curl http://localhost:9528/api/stats
  
✅ 部署完成！
```

### 2.4 验证部署

```bash
# 检查 PM2 进程
pm2 list

# 应该看到 2 个进程:
#   utls-proxy       online
#   zeromaps-rpc     online

# 检查端口
sudo netstat -tlnp | grep -E '9527|9528|9530|8765'

# 健康检查
curl http://localhost:9528/api/stats
curl http://localhost:8765/health

# 查看日志
pm2 logs zeromaps-rpc --lines 50
pm2 logs utls-proxy --lines 50
```

### 2.5 可选：安装 Caddy

```bash
# 安装 Caddy
sudo ./deploy.sh --install-caddy

# 或手动安装
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy

# 配置 Caddy
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy

# 访问管理面板
https://tile0.zeromaps.cn
```

---

## 3. 配置管理

### 3.1 配置体系

**三层配置**:
1. **VPS 物理配置** (`configs/vps-{IP}.conf`)
   - IPv6 前缀、接口名称
   - 服务器名称、域名
   - 不提交到 Git

2. **运行时默认配置** (`config/default.json`)
   - 端口、超时、并发数
   - 所有节点共享
   - 提交到 Git

3. **节点特定配置** (`config/node-{hostname}.json`)
   - 覆盖默认配置
   - 节点特定参数
   - 不提交到 Git

### 3.2 修改配置

#### 3.2.1 修改 VPS 物理配置

```bash
# 编辑配置
vim /opt/zeromaps-rpc/configs/vps-$(curl -s ifconfig.me).conf

# 修改后，重新生成 PM2 配置
cd /opt/zeromaps-rpc
sudo ./auto-update.sh
```

#### 3.2.2 修改运行时配置

```bash
# 编辑默认配置
vim /opt/zeromaps-rpc/config/default.json

# 修改示例:
{
    "utls": {
        "concurrency": 25  // 从 20 改为 25
    }
}

# 重启服务生效
pm2 restart all
```

#### 3.2.3 创建节点特定配置

```bash
# 复制示例配置
cp config/node-example.json config/node-$(hostname).json

# 编辑配置
vim config/node-$(hostname).json

# 示例:
{
    "utls": {
        "concurrency": 15  // 本节点并发数降低
    },
    "ipv6": {
        "count": 50  // 本节点 IPv6 池减半
    }
}

# 重启生效
pm2 restart zeromaps-rpc
```

### 3.3 配置优先级

```
环境变量 (PM2 env)
    ↓ 覆盖
config/node-{hostname}.json
    ↓ 覆盖
config/default.json
```

**示例**:
```javascript
// config/default.json
{
    "utls": {
        "concurrency": 20
    }
}

// config/node-tile0.json
{
    "utls": {
        "concurrency": 25  // 覆盖默认值
    }
}

// ecosystem.config.cjs
env: {
    UTLS_CONCURRENCY: '30'  // 最高优先级，覆盖所有配置
}
```

---

## 4. 多节点部署

### 4.1 节点列表配置

在主节点（如 tile0）创建 `config/nodes.json`:

```json
{
    "nodes": [
        {
            "name": "tile0",
            "domain": "tile0.zeromaps.cn",
            "webhookUrl": "https://tile0.zeromaps.cn/webhook"
        },
        {
            "name": "tile3",
            "domain": "tile3.zeromaps.cn",
            "webhookUrl": "https://tile3.zeromaps.cn/webhook"
        },
        {
            "name": "tile4",
            "domain": "tile4.zeromaps.cn",
            "webhookUrl": "https://tile4.zeromaps.cn/webhook"
        },
        {
            "name": "tile5",
            "domain": "tile5.zeromaps.cn",
            "webhookUrl": "https://tile5.zeromaps.cn/webhook"
        },
        {
            "name": "tile6",
            "domain": "tile6.zeromaps.cn",
            "webhookUrl": "https://tile6.zeromaps.cn/webhook"
        },
        {
            "name": "tile12",
            "domain": "tile12.zeromaps.cn",
            "webhookUrl": "https://tile12.zeromaps.cn/webhook"
        },
        {
            "name": "www",
            "domain": "www.zeromaps.com.cn",
            "webhookUrl": "https://www.zeromaps.com.cn/webhook"
        }
    ]
}
```

### 4.2 批量部署

#### 4.2.1 准备配置文件

在本地准备所有节点的配置：
```
configs/
  ├── vps-172.93.47.57.conf    # tile0
  ├── vps-65.49.192.85.conf    # tile3
  ├── vps-65.49.195.185.conf   # tile4
  ├── vps-65.49.194.100.conf   # tile5
  ├── vps-66.112.211.45.conf   # tile6
  ├── vps-107.182.186.123.conf # tile12
  └── vps-45.78.5.252.conf     # www
```

#### 4.2.2 提交配置到 Git

```bash
# 注意：configs/ 目录的文件不提交到 Git
# 需要手动分发到各节点
```

#### 4.2.3 部署到每个节点

**方法 1: SSH 手动部署**
```bash
# 连接到节点
ssh root@tile0.zeromaps.cn

# 部署
cd /opt/zeromaps-rpc
sudo ./deploy.sh
```

**方法 2: 批量部署脚本**
```bash
#!/bin/bash
NODES=(
    "tile0.zeromaps.cn"
    "tile3.zeromaps.cn"
    "tile4.zeromaps.cn"
    "tile5.zeromaps.cn"
    "tile6.zeromaps.cn"
    "tile12.zeromaps.cn"
    "www.zeromaps.com.cn"
)

for node in "${NODES[@]}"; do
    echo "部署到 $node..."
    ssh root@$node "cd /opt/zeromaps-rpc && sudo ./deploy.sh"
done
```

### 4.3 负载均衡

**DNS 轮询**:
```
zeromaps-rpc.example.com  A  172.93.47.57  # tile0
zeromaps-rpc.example.com  A  65.49.192.85  # tile3
zeromaps-rpc.example.com  A  65.49.195.185 # tile4
```

**客户端轮询**:
```typescript
const nodes = [
    { host: 'tile0.zeromaps.cn', port: 9527 },
    { host: 'tile3.zeromaps.cn', port: 9527 },
    { host: 'tile4.zeromaps.cn', port: 9527 }
]

// 随机选择节点
const node = nodes[Math.floor(Math.random() * nodes.length)]
const client = new RpcClient(node.host, node.port)
```

---

## 5. 自动更新

### 5.1 配置 GitHub Webhook

#### 5.1.1 在 GitHub 仓库配置

1. 打开仓库设置: `https://github.com/vistone/zeromaps-rpc/settings/hooks`
2. 点击 "Add webhook"
3. 配置参数:
   - **Payload URL**: `https://tile0.zeromaps.cn/webhook`
   - **Content type**: `application/json`
   - **Secret**: 配置在 `config/default.json` 中的 `server.webhook.secret`
   - **Events**: `Just the push event`
   - **Active**: ✅

#### 5.1.2 配置 Secret

```json
// config/default.json
{
    "server": {
        "webhook": {
            "secret": "your-secret-here"
        }
    }
}
```

### 5.2 自动更新流程

```
[GitHub Push]
   │
   ↓
[Webhook 触发]
   ├─> tile0 收到 Webhook
   │   ├─ 验证签名
   │   ├─ 同步代码 (git reset --hard origin/master)
   │   ├─ 执行 auto-update.sh (nohup 后台)
   │   └─ 转发到其他 6 个节点
   │
   ↓
[其他节点并行更新]
   ├─> tile3 执行 auto-update.sh
   ├─> tile4 执行 auto-update.sh
   ├─> tile5 执行 auto-update.sh
   ├─> tile6 执行 auto-update.sh
   ├─> tile12 执行 auto-update.sh
   └─> www 执行 auto-update.sh
   
   ↓
[每个节点执行]
   ├─ 1. 停止所有服务 (pm2 delete all)
   ├─ 2. 检查 Go 版本（自动升级到 1.24.9）
   ├─ 3. 安装依赖 (npm install)
   ├─ 4. 编译代码 (TypeScript + Go)
   ├─ 5. 生成 PM2 配置 (读取 configs/)
   ├─ 6. 启动服务 (pm2 start)
   └─ 7. 验证健康检查
   
   ↓
[完成]
   ✅ 所有节点自动更新完成
```

### 5.3 查看更新日志

```bash
# 实时查看更新过程
tail -f /var/log/zeromaps-auto-update.log

# 查看最近更新
tail -200 /var/log/zeromaps-auto-update.log

# 查看错误日志
cat /var/log/zeromaps-auto-update-error.log
```

### 5.4 手动更新

```bash
# 方法 1: 使用 update.sh
cd /opt/zeromaps-rpc
sudo ./update.sh

# 方法 2: 直接调用 auto-update.sh
cd /opt/zeromaps-rpc
sudo ./auto-update.sh

# 方法 3: Git 手动同步
cd /opt/zeromaps-rpc
git pull
npm install
npm run build
cd utls-proxy && bash build.sh
pm2 restart all
```

---

## 6. 监控和运维

### 6.1 监控面板

**统一管理面板** (推荐):
```
https://tile4.zeromaps.cn
https://tile12.zeromaps.cn
https://www.zeromaps.com.cn
```

**功能**:
- ✅ 一页查看所有 7 个节点状态
- ✅ 实时请求日志（WebSocket 推送）
- ✅ IPv6 地址池使用情况
- ✅ 系统资源监控（CPU、内存）
- ✅ 健康状态（Google API、uTLS 代理）

**单节点监控**:
```
http://tile0.zeromaps.cn:9528
http://tile3.zeromaps.cn:9528
```

### 6.2 日志管理

#### 6.2.1 PM2 日志

```bash
# 查看实时日志
pm2 logs zeromaps-rpc
pm2 logs utls-proxy

# 查看错误日志
pm2 logs zeromaps-rpc --err

# 查看最近 100 行
pm2 logs zeromaps-rpc --lines 100

# 清空日志
pm2 flush

# 日志文件位置
/opt/zeromaps-rpc/logs/combined.log
/opt/zeromaps-rpc/logs/error.log
/opt/zeromaps-rpc/logs/utls-proxy.log
```

#### 6.2.2 自动日志轮转

```bash
# 安装 PM2 日志轮转插件
pm2 install pm2-logrotate

# 配置轮转
pm2 set pm2-logrotate:max_size 100M     # 单个文件最大 100MB
pm2 set pm2-logrotate:retain 7          # 保留 7 个文件
pm2 set pm2-logrotate:compress true     # 压缩旧日志
pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss

# 查看配置
pm2 get pm2-logrotate
```

### 6.3 健康检查

```bash
# 检查所有节点健康状态
for node in tile0 tile3 tile4 tile5 tile6 tile12 www; do
    echo "=== $node ==="
    curl -s http://$node.zeromaps.cn:9528/api/stats | jq '.health, .utlsHealth'
done

# 检查 uTLS 代理
curl http://localhost:8765/health

# 检查 IP 池状态
curl http://localhost:8765/ip-pool | jq .
```

### 6.4 性能监控

```bash
# 系统资源
top -b -n 1 | grep -E 'node|utls'
htop

# 内存使用
pm2 monit

# 网络流量
iftop
nethogs

# 磁盘 I/O
iotop
```

---

## 7. 故障排查

### 7.1 服务无法启动

**症状**: `pm2 list` 显示进程不在线或只有 1 个进程

**排查步骤**:
```bash
# 1. 查看错误日志
pm2 logs --err --lines 50

# 2. 检查编译产物
ls -lh dist/server/index.js
ls -lh utls-proxy/utls-proxy

# 3. 手动启动测试
cd /opt/zeromaps-rpc
node dist/server/index.js  # 查看 Node.js 错误
./utls-proxy/utls-proxy    # 查看 Go 错误

# 4. 检查端口占用
sudo netstat -tlnp | grep -E '9527|9528|9530|8765'
sudo fuser -k 9527/tcp  # 强制释放端口

# 5. 重新部署
sudo ./auto-update.sh
```

**常见原因**:
- ❌ 编译失败（检查 TypeScript 或 Go 错误）
- ❌ 端口被占用（auto-update.sh 会自动清理）
- ❌ Go 版本不对（auto-update.sh 会自动安装 1.24.9）

### 7.2 Webhook 自动更新不工作

**症状**: GitHub 推送后，节点没有更新

**排查步骤**:
```bash
# 1. 查看 webhook 日志
pm2 logs zeromaps-rpc | grep -i webhook

# 2. 查看自动更新日志
tail -100 /var/log/zeromaps-auto-update.log

# 3. 检查 PM2 进程
pm2 list

# 4. 手动测试更新
cd /opt/zeromaps-rpc
git pull
sudo ./auto-update.sh
```

**常见原因**:
- ❌ GitHub Webhook 配置错误（检查 Payload URL）
- ❌ 防火墙阻止 9530 端口
- ❌ 更新标志卡死（等待 5 分钟自动重置）

### 7.3 IPv6 地址池显示"未启用"

**症状**: 监控面板显示"未启用 IPv6 地址池"，但 VPS 有 IPv6

**原因**:
- `ecosystem.config.cjs` 中缺少 `IPV6_PREFIX` 环境变量
- 或者配置文件中 `IPV6_PREFIX` 为空

**修复**:
```bash
# 1. 检查配置文件
cat configs/vps-$(curl -s ifconfig.me).conf | grep IPV6_PREFIX

# 2. 如果有前缀，重新运行 auto-update.sh
sudo ./auto-update.sh

# 3. 验证 PM2 配置
cat ecosystem.config.cjs | grep IPV6_PREFIX

# 4. 重启服务
pm2 restart zeromaps-rpc
```

### 7.4 请求超时或错误率高

**症状**: 大量请求 70+ 秒超时，或返回 403

**排查**:
```bash
# 1. 检查健康状态
curl http://localhost:9528/api/stats | jq '.health, .utlsHealth'

# 2. 查看 IP 池状态
curl http://localhost:8765/ip-pool | jq .

# 3. 查看实时日志
pm2 logs zeromaps-rpc --lines 50
```

**常见原因和解决方案**:

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| **70+ 秒超时** | 不支持 IPv6 但使用 IPv4 IP 池 | v2.3.12 已修复：自动禁用 IP 池 |
| **返回 403** | Google 封禁节点 | 紧急停止机制会自动拒绝后续请求 |
| **返回 23B 错误页** | Google 限流 | v2.3.16 已修复：触发紧急检查 |
| **并发太高被封** | concurrency 设置过高 | v2.3.13 已改为 20 |

### 7.5 Git 冲突导致无法更新

**症状**: `git pull` 报错 `Your local changes would be overwritten`

**解决**:
```bash
# auto-update.sh 使用强制同步，不会有冲突
cd /opt/zeromaps-rpc
sudo ./auto-update.sh

# 或手动强制同步
git fetch origin master
git reset --hard origin/master
```

---

## 8. 备份和恢复

### 8.1 备份策略

**需要备份的文件**:
```
/opt/zeromaps-rpc/
  ├── configs/vps-*.conf       # VPS 配置（重要！）
  ├── config/node-*.json       # 节点特定配置
  ├── ecosystem.config.cjs     # PM2 配置（可重新生成）
  └── utls-proxy/ip-pools.json # DNS IP 池（运行时生成）
```

**不需要备份**:
- `node_modules/` - NPM 依赖（可重新安装）
- `dist/` - 编译产物（可重新编译）
- `logs/` - 日志文件

### 8.2 备份命令

```bash
# 创建备份目录
mkdir -p ~/zeromaps-backup/$(date +%Y%m%d)

# 备份配置文件
cp /opt/zeromaps-rpc/configs/vps-*.conf ~/zeromaps-backup/$(date +%Y%m%d)/
cp /opt/zeromaps-rpc/config/node-*.json ~/zeromaps-backup/$(date +%Y%m%d)/ 2>/dev/null || true
cp /opt/zeromaps-rpc/ecosystem.config.cjs ~/zeromaps-backup/$(date +%Y%m%d)/
cp /opt/zeromaps-rpc/utls-proxy/ip-pools.json ~/zeromaps-backup/$(date +%Y%m%d)/ 2>/dev/null || true

# 打包压缩
tar -czf ~/zeromaps-backup-$(date +%Y%m%d).tar.gz ~/zeromaps-backup/$(date +%Y%m%d)
```

### 8.3 自动备份脚本

```bash
#!/bin/bash
# /opt/zeromaps-rpc/backup.sh

BACKUP_DIR="/backup/zeromaps"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR

# 备份配置
tar -czf $BACKUP_DIR/config-$DATE.tar.gz \
    /opt/zeromaps-rpc/configs/vps-*.conf \
    /opt/zeromaps-rpc/config/node-*.json \
    /opt/zeromaps-rpc/ecosystem.config.cjs \
    /opt/zeromaps-rpc/utls-proxy/ip-pools.json 2>/dev/null

# 删除 7 天前的备份
find $BACKUP_DIR -name "config-*.tar.gz" -mtime +7 -delete

echo "Backup completed: $BACKUP_DIR/config-$DATE.tar.gz"
```

**配置 Cron 定时任务**:
```bash
# 每天凌晨 3 点自动备份
crontab -e

# 添加:
0 3 * * * /opt/zeromaps-rpc/backup.sh
```

### 8.4 恢复步骤

```bash
# 1. 解压备份
tar -xzf ~/zeromaps-backup-20251020.tar.gz

# 2. 恢复配置文件
cp ~/zeromaps-backup/20251020/vps-*.conf /opt/zeromaps-rpc/configs/
cp ~/zeromaps-backup/20251020/node-*.json /opt/zeromaps-rpc/config/ 2>/dev/null || true

# 3. 重新生成 PM2 配置
cd /opt/zeromaps-rpc
sudo ./auto-update.sh

# 4. 验证服务
pm2 list
curl http://localhost:9528/api/stats
```

---

## 附录

### A. 快速参考

**常用命令**:
```bash
# 查看服务状态
pm2 list

# 重启服务
pm2 restart all

# 查看日志
pm2 logs zeromaps-rpc --lines 50

# 更新代码
cd /opt/zeromaps-rpc && sudo ./update.sh

# 健康检查
curl http://localhost:9528/api/stats
curl http://localhost:8765/health

# 查看 IP 池
curl http://localhost:8765/ip-pool | jq .
```

### B. 端口分配

| 服务 | 端口 | 用途 |
|------|------|------|
| RPC Server | 9527 | 客户端连接 |
| Monitor Server | 9528 | 监控和管理 |
| Webhook Server | 9530 | GitHub 自动更新 |
| uTLS Proxy | 8765 | 内部代理（不对外） |
| Caddy | 80/443 | HTTPS 反向代理 |

### C. 配置文件清单

| 文件 | 用途 | Git |
|------|------|-----|
| `configs/vps-{IP}.conf` | VPS 物理配置 | ❌ |
| `config/default.json` | 默认配置 | ✅ |
| `config/node-{hostname}.json` | 节点特定配置 | ❌ |
| `ecosystem.config.cjs` | PM2 配置 | ❌ |
| `utls-proxy/ip-pools.json` | DNS IP 池 | ❌ |

### D. 环境变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `IPV6_PREFIX` | IPv6 前缀 | `2607:8700:5500:2943` |
| `NODE_ENV` | 运行环境 | `production` |
| `UTLS_PROXY_PORT` | uTLS 端口 | `8765` |
| `UTLS_CONCURRENCY` | 并发数 | `20` |
| `LOG_LEVEL` | 日志级别 | `info` |

---

**文档维护**: 本文档随代码更新，请保持同步。  
**最后更新**: 2025-10-20  
**版本**: v2.3.x

---

## 🔒 生产加固与运维检查清单（增强）

### 1) 反向代理与访问控制
- 仅允许内网或受信网段访问 `:9528`（监控）与 `:9530`（Webhook）
- 若必须公网暴露：
  - 对 `/api/*` 与 `/ws` 启用 Basic/Auth 或 JWT
  - 对 `/webhook` 启用 TLS + 强制签名校验
  - 速率限制与并发限制（示例：`/api/stats` 每 IP 每秒 2 次）

### 2) Webhook 安全要求（必须）
- 设置 `server.webhook.secret`，GitHub 端与服务端一致
- 未配置 secret 时：拒绝（401），不要执行更新
- 验证 `X-Hub-Signature-256`；失败即拒绝
- 转发请求使用固定 UA：`ZeroMaps-Webhook-Forwarder`，避免转发环

### 3) 监控端点安全
- 建议仅内网访问
- 若公网暴露：
  - Basic/Auth 或 JWT
  - 响应体脱敏（隐藏内部 IP、路径、头）
  - WebSocket 推送采样与脱敏

### 4) 速率限制建议（反代或服务端实现）
- `/api/stats`: 2r/s/IP
- `/api/errorLogs`: 1r/5s/IP
- `/ws`: 并发连接 ≤ 50；消息采样在高负载下降低频率
- `/api/fetch`: 仅开发环境启用，生产禁用或白名单

### 5) 日志与回滚策略
- Go 代理日志轮转：已内置（每小时检查）；确认 `UTLS_LOG_FILE` 有写权限
- Node 日志：使用 pm2-logrotate 插件（已在 README 中示例）
- 回滚建议：
  - Webhook 更新前记录当前 commit（`git rev-parse HEAD`）
  - 更新失败时 `git reset --hard <last_good_commit>` + 重启
  - 可选：维护 `releases/` 目录，采用“符号链接原子切换”

### 6) 配置管理策略
- 将可热更新与需重启配置分离：
  - Hot Reload：`logging.level`、`performance.healthCheckInterval` 等
  - Hard Restart：端口、IPv6 池规模/前缀
- 提供配置 API 的白名单（服务端约束），避免误改关键项

### 7) 定期审计
- Webhook 安全：签名、TLS、来源 IP（GitHub Hooks IP 列表）
- 监控端口访问来源：仅内网或跳板机
- 日志大小与保留周期：符合磁盘配额
- Go/Node 版本：与项目要求一致

