# ZeroMaps RPC

基于 uTLS + IPv6 池的高性能 Google Earth 数据获取系统。使用 Go uTLS 完美模拟 Chrome 浏览器指纹，配合会话管理绕过 Google 检测。

## 📋 目录

- [项目架构](#项目架构)
- [配置体系](#配置体系)
- [脚本说明](#脚本说明)
- [快速开始](#快速开始)
- [自动更新机制](#自动更新机制)
- [监控访问](#监控访问)
- [已配置的VPS](#已配置的VPS)
- [技术方案](#技术方案)
- [常见问题](#常见问题)

## 🏗️ 项目架构

### 核心组件

```
ZeroMaps RPC 系统
├── Go uTLS Proxy (端口 8765)
│   ├── TLS 指纹模拟（完美模拟 Chrome）
│   ├── Session 管理（自动获取 Cookie）
│   ├── DNS IP 池（减少 DNS 解析）
│   └── 熔断器（失败保护）
│
├── Node.js RPC Server (端口 9527)
│   ├── 客户端连接管理
│   ├── IPv6 地址池轮询
│   ├── 请求队列管理
│   └── 紧急停止机制
│
├── Monitor Server (端口 9528)
│   ├── HTTP API（实时统计）
│   ├── WebSocket（实时推送）
│   └── P2P 同步（IP 池共享）
│
└── Webhook Server (端口 9530)
    ├── GitHub 自动更新
    └── 节点间转发
```

### 数据流向

```
客户端 → RPC Server (9527)
            ↓
     选择 IPv6 地址（如果有）
            ↓
     → Go uTLS Proxy (8765)
            ↓
     选择 DNS IP 池（95%）或域名（5%）
            ↓
     → Google Earth API
            ↓
     ← 返回 Protobuf 数据
            ↓
     ← RPC Server → 客户端
```

## ⚙️ 配置体系

### 配置文件层次

系统使用**三层配置体系**，各司其职：

#### 1. `configs/vps-{IP}.conf` - 物理配置（部署级）

**用途**：定义每个 VPS 的物理参数  
**使用者**：`deploy.sh`（初始部署）、`auto-update.sh`（动态生成 PM2 配置）  
**不提交到 Git**：每个 VPS 不同

```bash
# 示例：configs/vps-45.78.5.252.conf
SERVER_NAME="www"
SERVER_DOMAIN="www.zeromaps.com.cn"
IPV6_PREFIX="2607:8700:5500:d197"
INTERFACE="ipv6net"
REMOTE_IP="45.32.66.87"
```

#### 2. `config/default.json` - 运行时默认配置

**用途**：定义所有节点共享的默认参数  
**提交到 Git**：是

```json
{
  "utls": {
    "concurrency": 20,  // 并发数
    "timeout": 10000
  },
  "ipv6": {
    "start": 1001,
    "count": 100
  }
}
```

#### 3. `config/node-{hostname}.json` - 节点特定配置（可选）

**用途**：覆盖特定节点的配置  
**不提交到 Git**：节点特定

```json
{
  "utls": {
    "concurrency": 15  // 覆盖默认值
  }
}
```

### 配置优先级

```
环境变量 (PM2 env)
    ↓ 覆盖
config/node-{hostname}.json
    ↓ 覆盖  
config/default.json
```

## 📜 脚本说明

### `deploy.sh` - 初始部署脚本

**职责**：在全新 VPS 上完整部署系统

**流程**：
1. 检测本地 IP
2. 加载 `configs/vps-{IP}.conf`
3. 配置 IPv6 隧道和地址池（如果有）
4. 安装系统依赖（Node.js、PM2、Go）
5. 编译代码（TypeScript + Go）
6. 生成 `ecosystem.config.cjs`（包含 `IPV6_PREFIX`）
7. 启动服务（PM2）
8. 可选：安装 Caddy 和管理面板

**特点**：
- ✅ 读取 configs/ 配置
- ✅ 自动检测 IP
- ✅ 自动配置环境
- ✅ 幂等性：可重复执行

### `auto-update.sh` - 自动更新脚本

**职责**：Webhook 触发或手动更新时执行

**流程**：
1. 检测本地 IP，加载 `configs/vps-{IP}.conf`
2. 同步最新代码（如果需要）
3. 停止所有服务（pm2 delete all）
4. 检查并升级 Go 版本
5. 安装依赖（npm install）
6. 编译代码（TypeScript + Go）
7. 生成 `ecosystem.config.cjs`（使用 configs/ 中的 IPV6_PREFIX）
8. 启动服务（PM2）

**特点**：
- ✅ 读取 configs/ 配置
- ✅ 动态生成 PM2 配置
- ✅ 卸载-安装模式（简单可靠）
- ✅ 详细日志：`/var/log/zeromaps-auto-update.log`

### `update.sh` - 简化的更新脚本

**职责**：手动更新时的简化入口

```bash
bash $INSTALL_DIR/auto-update.sh
```

## ⚡ 快速开始

### 初次部署

```bash
git clone https://github.com/vistone/zeromaps-rpc.git /opt/zeromaps-rpc
cd /opt/zeromaps-rpc
sudo ./deploy.sh  # 自动检测 IP 并加载对应配置
```

### 手动更新

```bash
cd /opt/zeromaps-rpc
git pull
sudo ./auto-update.sh  # 或 sudo ./update.sh
```

### 自动更新机制

系统支持 GitHub Webhook 自动更新，**一次推送，所有节点自动更新**。

#### GitHub Webhook 配置

**只需配置一个主节点即可**（推荐：tile0.zeromaps.cn）

```
Payload URL: https://tile0.zeromaps.cn/webhook
Content type: application/json
Secret: (可选，在 config/default.json 中设置)
Events: Just the push event
Active: ✅
```

#### 工作流程

```
GitHub Push
    ↓
tile0.zeromaps.cn/webhook 收到
    ↓
┌─────────────────────────────────┐
│ 1. 同步最新代码                   │
│    git fetch + reset             │
│ 2. 启动 auto-update.sh (nohup)  │
│ 3. 转发到其他 6 个节点            │
└─────────────────────────────────┘
    ↓                    ↓
本节点更新        并行转发 webhook
    ↓                    ↓
[完整更新]        ├─> tile3.zeromaps.cn/webhook
                 ├─> tile4.zeromaps.cn/webhook
                 ├─> tile5.zeromaps.cn/webhook
                 ├─> tile6.zeromaps.cn/webhook
                 ├─> tile12.zeromaps.cn/webhook
                 └─> www.zeromaps.com.cn/webhook
                      ↓
                 每个节点独立执行 auto-update.sh
                      ↓
                 ✅ 所有节点更新完成
```

#### 更新过程详解

**每个节点执行的步骤**：

```bash
[1/7] 彻底清理所有进程
  - pm2 delete all
  - pkill 残留进程
  - 释放端口

[2/7] 确认代码版本
  - 读取 package.json

[3/7] 检查 Go 版本
  - 如果不是 1.24.9，自动下载安装

[4/7] 安装依赖
  - npm install
  - 安装 Git hooks

[5/7] 编译代码
  - TypeScript: npm run build
  - Go: cd utls-proxy && bash build.sh

[6/7] 生成 PM2 配置
  - 读取 configs/vps-{IP}.conf
  - 动态生成 ecosystem.config.cjs
  - 设置 IPV6_PREFIX 环境变量

[7/7] 启动服务
  - pm2 start utls-proxy (等待 3 秒)
  - pm2 start zeromaps-rpc (等待 3 秒)
  - 验证端口和健康检查
```

#### 查看更新日志

```bash
# 实时查看更新过程
tail -f /var/log/zeromaps-auto-update.log

# 查看最近更新
tail -200 /var/log/zeromaps-auto-update.log

# 如果有错误
cat /var/log/zeromaps-auto-update-error.log
```

#### 防止循环转发

转发的请求带有 `User-Agent: ZeroMaps-Webhook-Forwarder`，收到转发请求的节点不会再次转发。

## 📊 监控访问

### 统一管理面板

访问任意已安装 Caddy 的节点（通过 HTTPS）：

```
https://tile4.zeromaps.cn
https://tile12.zeromaps.cn
https://www.zeromaps.com.cn
```

**功能**：
- ✅ 一个页面查看所有 7 个节点状态
- ✅ 实时请求日志（WebSocket 推送）
- ✅ IPv6 地址池使用情况
- ✅ 系统资源监控（CPU、内存）
- ✅ 健康状态（Google API、uTLS 代理）
- ✅ 点击节点卡片查看详细信息

### 单节点监控

直接访问节点的监控端口（HTTP）：

```
http://tile0.zeromaps.cn:9528
http://tile3.zeromaps.cn:9528
```

**功能**：
- ✅ 实时请求日志
- ✅ IPv6 地址使用统计（Top 20）
- ✅ 请求成功率、响应时间
- ✅ uTLS 代理健康状态
- ✅ Google API 健康状态

### HTTP API

```bash
# 获取节点统计
curl http://节点:9528/api/stats

# 获取 IPv6 详细统计
curl http://节点:9528/api/ipv6-stats

# 获取健康状态
curl http://节点:9528/api/health

# uTLS 代理健康
curl http://节点:8765/health

# uTLS IP 池状态
curl http://节点:8765/ip-pool
```

## 🎯 已配置的VPS

| 节点 | 域名 | IPv4 | IPv6前缀 | 地址池 |
|------|------|------|----------|--------|
| tile0 | tile0.zeromaps.cn | 172.93.47.57 | 2607:8700:5500:2943 | ::1001 ~ ::1100 |
| tile3 | tile3.zeromaps.cn | 65.49.192.85 | 2607:8700:5500:e639 | ::1001 ~ ::1100 |
| tile4 | tile4.zeromaps.cn | 65.49.195.185 | 2607:8700:5500:1e09 | ::1001 ~ ::1100 |
| tile5 | tile5.zeromaps.cn | 65.49.194.100 | 2607:8700:5500:203e | ::1001 ~ ::1100 |
| tile6 | tile6.zeromaps.cn | 66.112.211.45 | 2607:8700:5500:bf4b | ::1001 ~ ::1100 |
| tile12 | tile12.zeromaps.cn | 107.182.186.123 | 2607:8700:5500:2043 | ::1001 ~ ::1100 |
| www | www.zeromaps.com.cn | 45.78.5.252 | 2607:8700:5500:d197 | ::1001 ~ ::1100 |

**每个节点 100 个 IPv6 地址，轮询使用，避免单地址请求过多被限流。**

## ⚙️ 可配置项

| 配置项 | 默认值 | 说明 | 配置位置 |
|--------|--------|------|----------|
| `utls.concurrency` | 20 | uTLS 并发数（推荐 20，过高易被封） | config/default.json |
| `utls.proxyPort` | 8765 | Go uTLS 代理端口 | config/default.json |
| `server.rpc.port` | 9527 | RPC 服务端口 | config/default.json |
| `server.monitor.port` | 9528 | 监控服务端口 | config/default.json |
| `server.webhook.port` | 9530 | Webhook 端口 | config/default.json |
| `ipv6.prefix` | 从 configs/ 读取 | IPv6 前缀 | configs/vps-{IP}.conf |
| `ipv6.count` | 100 | IPv6 地址池大小 | config/default.json |
| `ipv6.start` | 1001 | IPv6 起始编号 | config/default.json |
| `dns.ipPoolUsageRate` | 0.95 | IP 池使用率（95% IP池，5% 域名） | config/default.json |
| `logging.level` | info | 日志级别 | config/default.json |

### 修改配置的三种方式

#### 方式 1：修改 VPS 物理配置（configs/）

```bash
# 编辑对应的配置文件
vim /opt/zeromaps-rpc/configs/vps-$(curl -s ifconfig.me).conf

# 修改后，重新运行 auto-update.sh 生成 PM2 配置
./auto-update.sh
```

#### 方式 2：修改运行时配置（config/）

```bash
# 编辑默认配置
vim /opt/zeromaps-rpc/config/default.json

# 或创建节点特定配置
cp config/node-example.json config/node-$(hostname).json
vim config/node-$(hostname).json

# 重启服务生效
pm2 restart all
```

#### 方式 3：环境变量覆盖（临时）

```bash
# 修改 PM2 配置
vim /opt/zeromaps-rpc/ecosystem.config.cjs

# 在 env 中添加：
env: {
  UTLS_CONCURRENCY: '15',
  LOG_LEVEL: 'debug'
}

# 重启生效
pm2 restart all
```

## 🔧 常见问题

### 1. Webhook 自动更新不工作

**症状**：GitHub 推送后，节点没有更新

**排查步骤**：

```bash
# 1. 查看 webhook 日志
pm2 logs zeromaps-rpc | grep -i webhook

# 2. 查看自动更新日志
tail -100 /var/log/zeromaps-auto-update.log

# 3. 检查 PM2 进程
pm2 list

# 4. 手动测试更新
cd /opt/zeromaps-rpc && git pull && ./auto-update.sh
```

**常见原因**：
- ❌ GitHub Webhook 配置错误（检查 Payload URL）
- ❌ 防火墙阻止 9530 端口
- ❌ 更新标志卡死（等待 5 分钟自动重置）

### 2. 服务启动失败

**症状**：pm2 list 显示进程不在线或只有 1 个进程

**排查步骤**：

```bash
# 1. 查看错误日志
pm2 logs --err --lines 50

# 2. 检查编译产物
ls -lh /opt/zeromaps-rpc/dist/server/index.js
ls -lh /opt/zeromaps-rpc/utls-proxy/utls-proxy

# 3. 手动启动测试
cd /opt/zeromaps-rpc
node dist/server/index.js  # 查看启动错误
./utls-proxy/utls-proxy    # 查看 Go 代理错误

# 4. 重新部署
./auto-update.sh
```

**常见原因**：
- ❌ 编译失败（检查 TypeScript 或 Go 错误）
- ❌ 端口被占用（auto-update.sh 会自动清理）
- ❌ Go 版本不对（auto-update.sh 会自动安装 1.24.9）

### 3. IPv6 地址池显示"未启用"

**症状**：监控面板显示"未启用 IPv6 地址池"，但 VPS 有 IPv6

**原因**：
- `ecosystem.config.cjs` 中缺少 `IPV6_PREFIX` 环境变量
- 或者配置文件中 `IPV6_PREFIX` 为空

**修复**：

```bash
# 1. 检查配置文件
cat configs/vps-$(curl -s ifconfig.me).conf | grep IPV6_PREFIX

# 2. 如果有前缀，重新运行 auto-update.sh 生成配置
./auto-update.sh

# 3. 验证 PM2 配置
cat ecosystem.config.cjs | grep IPV6_PREFIX

# 4. 重启服务
pm2 restart zeromaps-rpc
```

### 4. 请求超时或错误率高

**症状**：大量请求 70+ 秒超时，或返回 403

**排查**：

```bash
# 1. 检查健康状态
curl http://localhost:9528/api/health

# 2. 查看 IP 池状态
curl http://localhost:8765/ip-pool

# 3. 查看实时日志
pm2 logs zeromaps-rpc --lines 50
```

**常见原因和解决方案**：

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| **70+ 秒超时** | 不支持 IPv6 但使用 IPv4 IP 池 | v2.3.12 已修复：自动禁用 IP 池 |
| **返回 403** | Google 封禁节点 | 紧急停止机制会自动拒绝后续请求 |
| **返回 23B 错误页** | Google 限流 | v2.3.16 已修复：触发紧急检查 |
| **并发太高被封** | concurrency 设置过高 | v2.3.13 已改为 20 |

### 5. 端口被占用

```bash
# auto-update.sh 会自动清理端口
./auto-update.sh

# 或手动清理
sudo fuser -k 9527/tcp  # RPC
sudo fuser -k 9528/tcp  # Monitor
sudo fuser -k 9530/tcp  # Webhook
sudo fuser -k 8765/tcp  # uTLS
```

### 6. Git 冲突导致无法更新

**症状**：`git pull` 报错 `Your local changes would be overwritten`

**解决**：

```bash
# auto-update.sh 使用强制同步，不会有冲突
./auto-update.sh

# 或手动强制同步
git fetch origin master
git reset --hard origin/master
```

## 🚀 客户端使用

```typescript
import { RpcClient } from 'zeromaps-rpc/client'

// 连接到服务器
const client = new RpcClient('tile0.zeromaps.cn', 9527)
await client.connect()

// 请求数据
const response = await client.fetchData('BulkMetadata/pb=!1m2!1s04!2u2699')
console.log(`状态码: ${response.statusCode}, 数据大小: ${response.data.length}`)
```

## 📁 目录结构

```
zeromaps-rpc/
├── deploy.sh          # 初始部署脚本（读取 configs/，生成 PM2 配置）
├── auto-update.sh     # 自动更新脚本（读取 configs/，动态生成配置）
├── update.sh          # 简化更新入口（调用 auto-update.sh）
├── Caddyfile          # Caddy 配置模板
├── ecosystem.config.cjs # PM2 配置（由脚本动态生成，不要手动修改）
│
├── configs/           # VPS 物理配置（每个 VPS 一个文件）
│   ├── vps-172.93.47.57.conf    # tile0
│   ├── vps-65.49.192.85.conf    # tile3
│   ├── vps-45.78.5.252.conf     # www
│   └── vps-no-ipv6.conf.example # 无 IPv6 的示例
│
├── config/            # 运行时配置
│   ├── default.json   # 默认配置（提交到 Git）
│   ├── node-*.json    # 节点特定配置（不提交）
│   └── nodes.json     # 所有节点列表（webhook 转发用）
│
├── utls-proxy/        # Go uTLS 代理（模拟 Chrome TLS 指纹）
│   ├── main.go        # 主程序
│   ├── dns_pool.go    # DNS IP 池管理
│   ├── ip-pools.json  # IP 池持久化文件
│   ├── build.sh       # 编译脚本
│   └── utls-proxy     # 编译产物（8.1M）
│
├── server/            # Node.js 服务端
│   ├── index.ts       # 入口
│   ├── rpc-server.ts  # RPC 服务器（客户端连接、请求处理）
│   ├── ipv6-pool.ts   # IPv6 地址池管理（轮询、统计）
│   ├── utls-fetcher.ts # uTLS Fetcher（调用 Go 代理）
│   ├── monitor-server.ts # 监控服务器（HTTP API + WebSocket）
│   ├── webhook-server.ts # Webhook 服务器（自动更新）
│   └── config-manager.ts # 配置管理器
│
├── client/            # 客户端 SDK
│   ├── rpc-client.ts  # RPC 客户端
│   └── ws-client.ts   # WebSocket 客户端
│
├── public/            # 统一管理面板
│   └── index.html     # 前端页面（查看所有节点）
│
├── hooks/             # Git hooks（自动检查版本号、commit 格式）
│   ├── pre-commit     # 提交前检查
│   ├── commit-msg     # 检查 commit 格式
│   └── post-commit    # 自动创建 tag
│
└── logs/              # 日志文件
    ├── utls-error.log
    ├── utls-out.log
    ├── zeromaps-error.log
    └── zeromaps-out.log
```

## 📈 性能指标

| 指标 | 数值 | 说明 |
|------|------|------|
| **QPS** | 10-15 req/s | 单服务器，受 Google 限流影响 |
| **成功率** | >99% | 配合 Cookie 会话和 IPv6 池 |
| **平均响应时间** | 150-300ms | 使用 IP 池减少 DNS 解析 |
| **并发数** | 20 | 推荐值，过高易被封 |
| **IPv6 地址池** | 100 个/节点 | ::1001 ~ ::1100 轮询 |
| **uTLS 内存** | ~15MB | Go 代理（单进程） |
| **主服务内存** | ~70MB | Node.js RPC 服务器 |
| **DNS IP 池** | 5-10 个/域名 | 自动刺探和淘汰 |

## 🔧 核心技术方案

### 1. Go uTLS 代理 - TLS 指纹模拟

使用 Go + [uTLS](https://github.com/refraction-networking/utls) 完美模拟 Chrome 120 浏览器。

**核心特性：**
- ✅ **完美 TLS 指纹**：100% 模拟 Chrome 120 的 TLS ClientHello
- ✅ **HTTP/2 支持**：原生 HTTP/2 协议支持
- ✅ **Session 管理**：自动从 earth.google.com 获取会话 Cookie
- ✅ **智能刷新**：403 错误时自动刷新 Cookie 并重试
- ✅ **极低内存**：单进程 ~15MB，处理所有请求
- ✅ **IPv4/IPv6 双栈**：自动适配网络环境

**工作流程：**
```
1. 首次请求 → 访问 earth.google.com/web/ 获取 Cookie
2. 使用 uTLS 模拟 Chrome 120 TLS 指纹
3. 带 Cookie 请求 kh.google.com API
4. Google 识别为："真实浏览器用户" ✓
5. 遇到 403 → 刷新 Session → 重试
```

**配置：**
```bash
UTLS_PROXY_PORT=8765       # 代理端口
UTLS_CONCURRENCY=20        # 并发数（推荐 20）
UTLS_LOG_FILE=logs/utls-proxy.log
```

### 2. DNS IP 池 - 减少 DNS 解析延迟

**目标**：减少每个请求的 DNS 解析时间（~50-200ms）

**策略**：
- 🎯 **混合请求**：95% 使用 IP 池，5% 使用域名（刺探新 IP）
- 🔍 **主动刺探**：启动时并发测试所有候选 IP
- 🏥 **健康管理**：实时监控 IP 成功率，自动淘汰失败 IP
- 💾 **持久化**：保存到 `utls-proxy/ip-pools.json`
- 🔄 **节点共享**：通过 WebSocket 共享 IP 池（P2P）

**自动适配 IPv6 支持**：
- ✅ **支持 IPv6**：使用 95% IP池 + 5% 域名
- ✅ **不支持 IPv6**：100% 使用域名（避免 IPv4 IP 池高错误率）

**IP 选择策略**：
```go
func (p *DNSIPPool) ShouldUseIPPool() bool {
    // 如果系统不支持 IPv6，完全禁用 IP 池
    if !p.hasIPv6Support {
        return false  // 100% 域名
    }
    
    // 支持 IPv6 时，95% IP 池
    count := p.requestCounter.Add(1)
    return count%20 != 0  // 每 20 个请求，1 个用域名
}
```

**IP 健康管理**：
```go
// 连续失败 3 次 → 移出活跃池
// 成功率 < 50% → 移出活跃池
// 黑名单 10 分钟后重试
```

### 3. IPv6 地址池轮询

**目标**：避免单个 IPv6 地址请求过多被限流

**实现**：
- 每个节点 100 个 IPv6 地址（::1001 ~ ::1100）
- 轮询使用，均匀分配请求
- 记录每个地址的统计信息（成功/失败/403/429）

**智能选择**：
```typescript
// 过滤掉被拉黑和高失败率的地址
getHealthyNext(): string | null {
  const healthyAddresses = this.addresses.filter(addr => {
    const stats = this.detailedStats.get(addr)
    
    // 1. 被拉黑（403 >= 5 次）→ 排除
    if (stats.error403Count >= 5) return false
    
    // 2. 失败率 > 30% 且请求数 > 20 → 排除
    if (stats.totalRequests > 20) {
      const failRate = stats.failureCount / stats.totalRequests
      if (failRate > 0.3) return false
    }
    
    return true
  })
  
  // 从健康地址中轮询选择
  return healthyAddresses[this.currentIndex++ % healthyAddresses.length]
}
```

### 4. 紧急停止机制

**目标**：检测到节点被 Google 拉黑时，立即停止服务

**触发条件**：
1. 请求返回 200 状态码
2. 但数据 < 50B（疑似错误页）
3. 或者返回 HTML/JSON 错误内容

**流程**：
```
1. 检测到可疑响应（200 + 小数据）
   ↓
2. 触发紧急健康检查
   - 使用原始 IPv4 curl 请求 Google
   - 绕过 uTLS 代理和 IPv6
   ↓
3. 如果确认 403
   - emergencyStop = true
   - 拒绝所有后续客户端请求
   - 返回：「服务已停止：节点被拉黑」
   ↓
4. 监控服务保持运行
   - 可以查看状态和日志
   - 等待人工处理
```

### 5. 熔断器（Circuit Breaker）

**目标**：防止持续请求失败的 IPv6 地址

**Go 代理层熔断器**：
```go
// 配置
失败率阈值: 80%
最小请求数: 20
恢复时间: 5 分钟

// 逻辑
if failureRate > 80% && requests > 20 {
    打开熔断器（5 分钟）
    拒绝该 IPv6 的所有请求
}
```

**Node.js 层 IPv6 池智能选择**：
```typescript
// 403 >= 5 次 → 标记为拉黑，不再使用
// 429 > 20% → 标记为限流，降低使用频率
// 404 不影响（数据不存在是正常的）
```

## 💡 最佳实践

### 配置建议

#### 并发数设置

| 场景 | 推荐值 | 说明 |
|------|--------|------|
| **生产环境** | 20 | 最佳平衡点，不易被封 |
| **测试环境** | 5-10 | 低流量测试 |
| **不推荐** | >30 | 高概率被 Google 限流 |

#### IPv6 地址池大小

| VPS 质量 | 推荐值 | 说明 |
|---------|-------|------|
| **高质量** | 100 | 标准配置 |
| **经常被封** | 200+ | 增加地址轮换 |
| **无 IPv6** | 0 | 使用默认网络 |

### 运维建议

#### 定期检查

```bash
# 每天检查一次节点状态
curl https://tile4.zeromaps.cn  # 统一管理面板

# 检查健康状态
for node in tile0 tile3 tile4 tile5 tile6 tile12 www; do
  echo "=== $node ==="
  curl -s http://$node.zeromaps.cn:9528/api/health | jq .
done

# 检查更新日志
ssh tile0 "tail -50 /var/log/zeromaps-auto-update.log"
```

#### 日志清理

```bash
# PM2 日志轮转（自动）
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 100M
pm2 set pm2-logrotate:retain 7

# 手动清理
pm2 flush  # 清空所有日志
```

#### 故障恢复

**如果节点被封禁（403）：**

```bash
# 1. 检查紧急停止状态
curl http://节点:9528/api/stats | jq .emergencyStop

# 2. 等待 Google 解封（通常 24-48 小时）

# 3. 重置状态（重启服务）
pm2 restart all

# 4. 或者更换 IP/IPv6 前缀
```

### 监控和调试

```bash
# 查看 IP 池状态
curl http://localhost:8765/ip-pool

# 查看 P2P 连接状态
curl http://localhost:9528/api/p2p-status

# 查看详细日志
tail -f /opt/zeromaps-rpc/logs/utls-proxy.log
```

## 📊 更新记录

### v2.3.x (2025-10-20)
- ✅ 配置体系重构：configs/ 物理配置 + config/ 运行时配置
- ✅ 自动更新脚本增强：卸载-安装模式，自动升级 Go
- ✅ Webhook 更新稳定性：nohup 独立进程，环境变量修复
- ✅ IPv6 自动检测：从 configs/ 读取配置（不再尝试自动检测）
- ✅ DNS IP 池优化：自动识别 IPv6 支持，IPv4 机器禁用 IP 池
- ✅ 紧急停止机制：检测 403 自动停止服务
- ✅ 统一管理面板：一页查看所有节点状态

### v2.2.x (2025-10-19)
- ✅ Go 版本自动升级（1.24.9）
- ✅ 编译验证增强（防止误判）
- ✅ Git hooks 实现（版本号检查、commit 格式）
- ✅ PM2 双进程管理（utls-proxy + zeromaps-rpc）

### v2.1.x (2025-10-18)
- ✅ 初始版本：uTLS 代理 + IPv6 池
- ✅ RPC 协议实现
- ✅ 监控面板和 WebSocket 实时推送

---

## 📄 License

MIT

---

**项目维护**: Stone (vistone)  
**GitHub**: https://github.com/vistone/zeromaps-rpc  
**文档版本**: v2.3.x (2025-10-20)
