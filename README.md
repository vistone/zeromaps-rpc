# ZeroMaps RPC

基于 uTLS + IPv6 池的高性能 Google Earth 数据获取系统。使用 Go uTLS 完美模拟 Chrome 浏览器指纹，配合会话管理绕过 Google 检测。

## ⚡ 快速开始

### 初次部署

```bash
git clone https://github.com/vistone/zeromaps-rpc.git /opt/zeromaps-rpc
cd /opt/zeromaps-rpc
sudo ./deploy.sh
```

### 更新服务

```bash
cd /opt/zeromaps-rpc
git pull
sudo ./update.sh
```

### 自动更新机制

系统支持 GitHub Webhook 自动更新，**一次推送，所有节点自动更新**：

1. **GitHub Webhook 配置**：只需配置一个主节点（如 tile0.zeromaps.cn）
2. **自动转发**：主节点收到 webhook 后，自动转发到其他 6 个节点
3. **并发更新**：所有节点同时执行更新，互不阻塞
4. **防止循环**：转发的请求不会再次转发，避免无限循环

**GitHub 配置示例**：
```
Payload URL: https://tile0.zeromaps.cn/webhook
Content type: application/json
Secret: (在配置文件中设置)
Events: Just the push event
```

**工作流程**：
```
GitHub Push → tile0 → 本节点更新 + 转发到其他 6 个节点
               ├─> tile3.zeromaps.cn/webhook ✅
               ├─> tile4.zeromaps.cn/webhook ✅
               ├─> tile5.zeromaps.cn/webhook ✅
               ├─> tile6.zeromaps.cn/webhook ✅
               ├─> tile12.zeromaps.cn/webhook ✅
               └─> www.zeromaps.com.cn/webhook ✅
```

## 📊 监控访问

### 统一管理面板

访问任意已安装Caddy的节点：
- `https://tile4.zeromaps.cn`
- `https://tile12.zeromaps.cn`
- 等等

可在一个页面查看所有7个VPS的状态。

### 单节点监控

```
http://节点域名:9528
```

## 🎯 已配置的VPS

| 节点 | 域名 | IPv4 | IPv6前缀 |
|------|------|------|----------|
| tile0 | tile0.zeromaps.cn | 172.93.47.57 | 2607:8700:5500:2943 |
| tile3 | tile3.zeromaps.cn | 65.49.192.85 | 2607:8700:5500:e639 |
| tile4 | tile4.zeromaps.cn | 65.49.195.185 | 2607:8700:5500:1e09 |
| tile5 | tile5.zeromaps.cn | 65.49.194.100 | 2607:8700:5500:203e |
| tile6 | tile6.zeromaps.cn | 66.112.211.45 | 2607:8700:5500:bf4b |
| tile12 | tile12.zeromaps.cn | 107.182.186.123 | 2607:8700:5500:2043 |
| www | www.zeromaps.com.cn | 45.78.5.252 | 2607:8700:5500:d197 |

## ⚙️ 配置管理

### 配置文件

系统支持多层配置，优先级从高到低：

1. **环境变量**（最高优先级）
2. **节点配置** `config/node-{主机名}.json`
3. **默认配置** `config/default.json`

### 快速配置

#### 方式一：编辑配置文件

```bash
# 创建节点特定配置
cp config/node-example.json config/node-$(hostname).json

# 编辑配置
vim config/node-$(hostname).json
```

#### 方式二：Web 界面管理

```bash
# 查看当前配置
curl http://节点域名:9528/api/config

# 更新配置（示例：修改并发数）
curl -X POST http://节点域名:9528/api/config \
  -H "Content-Type: application/json" \
  -d '{"utls.concurrency": 15}'
```

#### 方式三：环境变量

```bash
# 在 ecosystem.config.cjs 中配置
env: {
  IPV6_PREFIX: '2607:8700:5500:2043',
  UTLS_CONCURRENCY: '15',
  WEBHOOK_SECRET: 'your-secret',
  LOG_LEVEL: 'debug'
}
```

### 可配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `server.rpc.port` | 9527 | RPC 服务端口 |
| `server.monitor.port` | 9528 | 监控服务端口 |
| `server.webhook.port` | 9530 | Webhook 端口 |
| `utls.proxyPort` | 8765 | Go uTLS 代理端口 |
| `utls.concurrency` | 10 | 并发请求数（1-100） |
| `ipv6.prefix` | '' | IPv6 前缀 |
| `ipv6.count` | 100 | IPv6 地址池大小 |
| `ipv6.start` | 1001 | IPv6 起始编号 |
| `logging.level` | info | 日志级别（error/warn/info/debug） |
| `performance.maxRequestLogs` | 100 | 保留的请求日志数量 |
| `performance.healthCheckInterval` | 300000 | 健康检查间隔（毫秒） |

### 热加载

修改配置文件后自动重新加载，无需重启服务（部分配置需要重启生效）。

## 🔧 常见问题

### 端口被占用

```bash
cd /opt/zeromaps-rpc
sudo ./update.sh  # 自动清理端口冲突
```

### Caddy 502错误

```bash
cd /opt/zeromaps-rpc
git pull
sudo ./update.sh  # 自动更新Caddy配置
```

### 节点显示离线

```bash
# 在对应VPS上
pm2 list
pm2 logs zeromaps-rpc
sudo ./update.sh
```

### SSH超时断开

```bash
apt install screen -y
screen -S deploy
sudo ./deploy.sh
# Ctrl+A 然后 D 退出
```

## 📦 脚本说明

### deploy.sh - 初次部署

自动完成：
- ✅ 配置IPv6隧道（6in4）
- ✅ 添加100个IPv6地址池
- ✅ 安装Node.js 18、pm2
- ✅ 启动RPC和监控服务
- ✅ 可选安装Caddy和管理面板

### update.sh - 更新服务

自动完成：
- ✅ 更新代码（git pull）
- ✅ 更新依赖（npm install）
- ✅ 清理端口冲突
- ✅ 重启pm2服务
- ✅ 更新Caddy配置

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
├── deploy.sh          # 一键部署脚本
├── update.sh          # 服务更新脚本
├── Caddyfile          # Caddy配置模板
├── public/            # 统一管理面板
│   └── index.html
├── configs/           # VPS配置文件
├── utls-proxy/        # Go uTLS 代理（模拟 Chrome TLS 指纹）
│   ├── main.go        # uTLS 代理主程序
│   └── build.sh       # 编译脚本
├── server/            # Node.js 服务端
│   ├── index.ts       # 入口
│   ├── rpc-server.ts  # RPC 服务器
│   ├── ipv6-pool.ts   # IPv6 池管理
│   ├── utls-fetcher.ts # uTLS Fetcher
│   └── monitor-server.ts # 监控服务器
└── client/            # 客户端 SDK
```

## 📈 性能指标

- **QPS**: 10-15 req/s（单服务器）
- **成功率**: >99%（配合 Cookie 会话）
- **平均响应时间**: 150-300ms
- **IPv6 池**: 100 个地址（可选）
- **uTLS 内存**: ~15MB（Go 代理）
- **主服务内存**: ~70MB（Node.js）

## 🔧 技术方案

### Go uTLS 代理（唯一方案）

使用 Go + [uTLS](https://github.com/refraction-networking/utls) 完美模拟 Chrome 120 浏览器：

**核心特性：**
- ✅ **完美 TLS 指纹**：100% 模拟 Chrome 120 的 TLS ClientHello
- ✅ **HTTP/2 支持**：原生 HTTP/2 协议支持
- ✅ **Cookie 会话管理**：自动从 earth.google.com 获取会话 Cookie
- ✅ **极低内存占用**：单进程 ~15MB，处理所有请求
- ✅ **IPv4/IPv6 双栈**：自动适配网络环境

**工作流程：**
```
1. 访问 earth.google.com/web/ → 获取真实 Cookie
2. 使用 uTLS 模拟 Chrome TLS 指纹
3. 带着 Cookie 请求 kh.google.com API
4. Google 识别为："真实浏览器用户" ✓
```

**配置：**
```bash
UTLS_PROXY_PORT=8765    # uTLS 代理端口
UTLS_CONCURRENCY=10     # 并发数
```

## 🌐 DNS IP 池系统（分布式架构）

### 设计目标

通过预解析 DNS 和 IP 池管理，减少 DNS 解析延迟，提高请求性能。

### 核心特性

- ✅ **去中心化 P2P**：每个节点独立运行，相互通信
- ✅ **主动刺探**：启动时并发测试所有 IP，只保留可用的
- ✅ **持续优化**：定期刺探新 IP，淘汰失败的 IP
- ✅ **混合请求**：95% 用 IP 池（快），5% 用域名（刺探新 IP）
- ✅ **健康管理**：实时监控 IP 健康度，自动剔除失败 IP
- ✅ **节点共享**：通过 WebSocket 共享 IP 池和健康状态

### 架构设计

```
每个节点（独立 + 互联）：
  
  📦 本地 IP 池
  ├─ kh.google.com
  │  ├─ IPv4: [142.250.105.93, 142.250.105.190, ...]
  │  └─ IPv6: [2607:f8b0:4002:c1b::be, ...]
  └─ earth.google.com
     ├─ IPv4: [...]
     └─ IPv6: [...]
  
  🏥 IP 健康状态
  ├─ 142.250.105.93 → 成功率 95%, 连续成功 20 次
  ├─ 2607:f8b0:... → 成功率 80%, 连续失败 2 次
  └─ 142.250.105.91 → 成功率 45%, 连续失败 5 次 ❌ 已移除
  
  🔄 P2P 同步（WebSocket）
  ├─ 接收其他节点的 IP 池
  ├─ 接收其他节点的健康报告
  ├─ 广播自己的发现
  └─ 断线？使用本地池（不影响工作）
```

### 工作流程

#### 启动阶段（0-30 秒）
```
1. 加载静态默认 IP（预设）
2. DNS 解析获取候选 IP（可能 10-20 个）
3. 并发测试所有 IP（5 秒超时）
   - 200/404 → ✅ 加入活跃池
   - 403/超时 → ❌ 加入黑名单
4. 形成初始可用池（通常 5-10 个 IP）
5. 连接到其他节点（P2P）
```

#### 运行阶段（持续优化）
```
每个请求：
  ├─ 95% → 使用 IP 池（直连，无 DNS）
  │         https://[IP]:443/path + Host 头
  │         
  └─ 5% → 使用域名（刺探模式）
            https://domain/path
            → 记录实际连接的 IP
            → 发现新 IP 加入候选池

每 5 分钟：
  ├─ 重新解析 DNS
  ├─ 测试新发现的 IP
  ├─ 清理连续失败 5 次的 IP
  └─ 重试黑名单中的 IP（给机会恢复）

每 1 分钟：
  ├─ 上报 IP 健康状态给其他节点
  └─ 接收其他节点的健康报告
```

### IP 选择策略

**随机选择**（默认）：
```go
// 从健康的 IP 中随机选择
ip := healthyIPs[rand.Intn(len(healthyIPs))]
```

**健康过滤**：
- 成功率 < 50% → 移除
- 连续失败 >= 3 次 → 移除
- 平均响应时间 > 5 秒 → 降低优先级

### P2P 同步协议

**WebSocket 消息类型**：

```json
// 1. IP 池广播
{
  "type": "ip_pool_update",
  "node": "tile4",
  "timestamp": 1708318800000,
  "data": {
    "kh.google.com": {
      "ipv4": ["142.250.105.93", ...],
      "ipv6": ["2607:f8b0:...", ...]
    }
  }
}

// 2. IP 健康报告
{
  "type": "health_report",
  "node": "tile4",
  "data": {
    "142.250.105.93": {
      "total": 100,
      "success": 95,
      "avgRT": 150
    }
  }
}

// 3. 新 IP 发现
{
  "type": "ip_discovered",
  "node": "tile4",
  "ip": "142.250.106.100",
  "domain": "kh.google.com",
  "tested": true
}
```

### 配置示例

```json
{
  "dns": {
    "enabled": true,
    "domains": {
      "kh.google.com": {
        "preferIPv6": true,
        "ipPoolUsageRate": 0.95,
        "probeInterval": 300000,
        "defaultIPv4": [
          "142.250.105.93",
          "142.250.105.190",
          "142.250.105.136",
          "142.250.105.91"
        ],
        "defaultIPv6": [
          "2607:f8b0:4002:c1b::be",
          "2607:f8b0:4002:c1b::5b",
          "2607:f8b0:4002:c1b::88",
          "2607:f8b0:4002:c1b::5d"
        ]
      },
      "earth.google.com": {
        "preferIPv6": false,
        "ipPoolUsageRate": 0.90,
        "probeInterval": 600000
      }
    },
    "health": {
      "consecutiveFailsThreshold": 3,
      "successRateThreshold": 0.5,
      "blacklistDuration": 600000,
      "minPoolSize": 2
    }
  },
  "p2p": {
    "enabled": true,
    "nodes": [
      "tile0.zeromaps.cn:9528",
      "tile3.zeromaps.cn:9528",
      "tile4.zeromaps.cn:9528",
      "tile5.zeromaps.cn:9528",
      "tile6.zeromaps.cn:9528",
      "tile12.zeromaps.cn:9528",
      "www.zeromaps.com.cn:9528"
    ],
    "syncInterval": 60000,
    "healthReportInterval": 60000,
    "reconnectDelay": 5000
  }
}
```

### 性能优化

**减少 DNS 解析**：
- 传统方式：每个请求都 DNS 解析（~50-200ms）
- IP 池方式：直接 IP 连接（~0ms）
- **性能提升**：每个请求节省 50-200ms

**智能负载均衡**：
- 自动发现最快的 IP
- 淘汰失败的 IP
- 多节点共享最优 IP 列表

### 故障恢复

**场景 1**：单个 IP 失败
```
IP1 连续失败 3 次
  ↓
自动切换到 IP2, IP3, ...
  ↓
IP1 加入黑名单（10 分钟）
  ↓
10 分钟后自动重试
```

**场景 2**：所有 IP 失败
```
池子中所有 IP 都失败
  ↓
降级到域名请求
  ↓
重新解析 DNS
  ↓
刺探新 IP
  ↓
重建 IP 池
```

**场景 3**：P2P 断线
```
WebSocket 连接断开
  ↓
使用本地 IP 池（不影响工作）
  ↓
定期尝试重连
  ↓
重连成功后同步最新 IP
```

### 监控和调试

**查看 IP 池状态**：
```bash
# 查看当前 IP 池
curl http://localhost:8765/ip-pool

# 查看 IP 健康状态
curl http://localhost:8765/ip-health

# 查看 P2P 连接状态
curl http://localhost:9528/api/p2p-status
```

**日志输出**：
```
[DNS-Pool] 🔍 开始刺探 kh.google.com...
[DNS-Pool] 📋 DNS 解析结果: 4 个 IPv4, 4 个 IPv6
[DNS-Pool]   ✅ 142.250.105.93 可用
[DNS-Pool]   ❌ 142.250.105.91 不可用 (403)
[DNS-Pool] ✅ IP 池初始化完成: 3 个可用 IPv4, 4 个可用 IPv6

[Proxy] 🎯 使用 IP 池: 142.250.105.93
[Proxy] 🔍 刺探模式：使用域名请求
[Proxy]   🆕 发现新 IP: 142.250.106.100

[P2P] 📡 接收到 tile3 的 IP 池更新
[P2P] 📊 接收到 tile4 的健康报告: IP1 成功率 95%
```

---

## License

MIT
