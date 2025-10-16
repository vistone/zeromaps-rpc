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

## License

MIT
