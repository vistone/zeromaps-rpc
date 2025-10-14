# ZeroMaps RPC

基于IPv6池和HTTP/2连接复用的高性能RPC服务，支持100个IPv6地址轮询。

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
├── configs/           # VPS配置（7个）
├── server/            # 服务端代码
│   ├── index.ts       # 入口
│   ├── rpc-server.ts  # RPC服务器
│   ├── ipv6-pool.ts   # IPv6池管理
│   ├── curl-fetcher.ts # Curl执行器
│   └── monitor-server.ts # 监控服务器
└── client/            # 客户端SDK
```

## 📈 性能指标

- **QPS**: 15-20 req/s（单服务器）
- **成功率**: >99.5%
- **平均响应时间**: 200-300ms
- **IPv6池**: 100个地址
- **负载平衡度**: <2

## 🚀 请求方式切换

系统支持两种 HTTP 请求方式，可通过环境变量切换：

### 方式1: Node.js 原生 HTTP/2（默认，推荐）
```bash
# 不设置或设置为 http（默认）
export FETCHER_TYPE=http
```

**优势**：
- ✅ **连接复用**：同域名请求共享连接，大幅降低延迟
- ✅ **HTTP/2 多路复用**：一个连接同时处理多个请求
- ✅ **内存占用低**：无需启动外部进程（15-20MB/并发）
- ✅ **DNS缓存**：减少 DNS 查询时间
- ✅ **TLS指纹**：模拟 Chrome 116 TLS 握手参数
- ⚡ **性能优异**：响应时间 500-800ms

**TLS 指纹配置**：
- 支持 TLS 1.2/1.3
- Chrome 116 加密套件顺序
- ALPN: h2, http/1.1

### 方式2: 系统 curl（备选）
```bash
# 设置为 curl 切换
export FETCHER_TYPE=curl
```

**优势**：
- ✅ 系统自带，无需额外安装
- ✅ 轻量稳定
- ❌ 每个请求启动独立进程
- ❌ 无连接复用

### 性能对比

| 指标 | HTTP/2（默认） | 系统 curl |
|------|---------------|-----------|
| 平均响应时间 | 500-800ms | 1000-1500ms |
| 内存占用 | 300MB | 500MB |
| 连接复用 | 80%+ | 0% |
| CPU 占用 | 低 | 中等 |

## License

MIT
