# ZeroMaps RPC API 参考文档

> **文档版本**: v2.3.x  
> **更新日期**: 2025-10-20  
> **维护者**: Stone (vistone)

## 📋 目录

- [1. RPC 协议](#1-rpc-协议)
- [2. HTTP API](#2-http-api)
- [3. WebSocket API](#3-websocket-api)
- [4. Go uTLS Proxy API](#4-go-utls-proxy-api)
- [5. 客户端 SDK](#5-客户端-sdk)
- [6. 错误码](#6-错误码)

---

## 1. RPC 协议

### 1.1 协议概述

**传输层**: TCP  
**编码格式**: Protocol Buffers  
**端口**: 9527 (可配置)

**帧格式**:
```
┌──────────────┬──────────────┬─────────────────┐
│  Payload长度  │   帧类型      │     Payload      │
│   (4 bytes)  │   (1 byte)   │   (N bytes)     │
│   uint32 BE  │   uint8      │   protobuf      │
└──────────────┴──────────────┴─────────────────┘
```

### 1.2 帧类型

| 类型 | 值 | 说明 |
|------|-----|------|
| `HANDSHAKE_REQUEST` | 1 | 客户端握手请求 |
| `HANDSHAKE_RESPONSE` | 2 | 服务器握手响应 |
| `DATA_REQUEST` | 3 | 数据请求 |
| `DATA_RESPONSE` | 4 | 数据响应 |

### 1.3 握手协议

#### 1.3.1 握手请求 (HandshakeRequest)

**方向**: 客户端 → 服务器

**Protobuf 定义**:
```protobuf
message HandshakeRequest {
    string clientInfo = 1;  // 客户端信息（版本、平台等）
}
```

**示例**:
```typescript
const request = HandshakeRequest.encode({
    clientInfo: 'ZeroMaps-Client/1.0.0 (Node.js 18.0.0)'
}).finish()

sendFrame(socket, FrameType.HANDSHAKE_REQUEST, request)
```

#### 1.3.2 握手响应 (HandshakeResponse)

**方向**: 服务器 → 客户端

**Protobuf 定义**:
```protobuf
message HandshakeResponse {
    uint32 clientID = 1;    // 服务器分配的客户端ID
    bool success = 2;       // 握手是否成功
    string message = 3;     // 消息（欢迎语或错误信息）
}
```

**示例响应**:
```json
{
    "clientID": 1,
    "success": true,
    "message": "Welcome to ZeroMaps RPC Server"
}
```

### 1.4 数据请求协议

#### 1.4.1 数据请求 (DataRequest)

**方向**: 客户端 → 服务器

**Protobuf 定义**:
```protobuf
message DataRequest {
    uint32 clientID = 1;    // 客户端ID（握手时获得）
    string uri = 2;         // 请求的 URI（不含域名）
    DataType dataType = 3;  // 数据类型（可选）
}

enum DataType {
    UNKNOWN = 0;
    BULKMETADATA = 1;
    NODEDATA = 2;
    IMAGERY = 3;
}
```

**URI 格式**:
```
BulkMetadata/pb=!1m2!1s04!2u2699
NodeData/pb=!1m2!1s0479ca!2u2699
ImageryMetadata/pb=!1m2!1s04!2u2699
```

**示例**:
```typescript
const request = DataRequest.encode({
    clientID: 1,
    uri: 'BulkMetadata/pb=!1m2!1s04!2u2699',
    dataType: DataType.BULKMETADATA
}).finish()

sendFrame(socket, FrameType.DATA_REQUEST, request)
```

#### 1.4.2 数据响应 (DataResponse)

**方向**: 服务器 → 客户端

**Protobuf 定义**:
```protobuf
message DataResponse {
    uint32 clientID = 1;    // 客户端ID
    string uri = 2;         // 原始请求的 URI
    bytes data = 3;         // 响应数据（protobuf 格式）
    uint32 statusCode = 4;  // HTTP 状态码
}
```

**状态码**:
- `200`: 成功
- `403`: 节点被拉黑或紧急停止
- `404`: 数据不存在
- `429`: 限流
- `500`: 服务器内部错误

**示例响应**:
```json
{
    "clientID": 1,
    "uri": "BulkMetadata/pb=!1m2!1s04!2u2699",
    "data": "<protobuf binary data>",
    "statusCode": 200
}
```

### 1.5 连接生命周期

```
[客户端]                           [服务器]
    │                                  │
    ├──── TCP 连接 ──────────────────→│
    │                                  │
    ├──── HandshakeRequest ──────────→│
    │                                  ├─ 分配 clientID
    │←──── HandshakeResponse ─────────┤
    │                                  │
    ├──── DataRequest (1) ───────────→│
    │←──── DataResponse (1) ───────────┤
    │                                  │
    ├──── DataRequest (2) ───────────→│
    │←──── DataResponse (2) ───────────┤
    │                                  │
    │         ... 持续连接 ...          │
    │                                  │
    ├──── TCP 关闭 ──────────────────→│
    │                                  ├─ 清理 session
    │                                  │
```

---

## 2. HTTP API

### 2.1 API 概述

**基础 URL**: `http://节点:9528`  
**响应格式**: JSON  
**认证**: 无（内部网络）

### 2.2 统计数据 API

#### 2.2.1 获取服务器统计

**端点**: `GET /api/stats`

**响应示例**:
```json
{
    "version": "2.3.27",
    "timestamp": 1729441234567,
    "clients": 5,
    "fetcherType": "utls",
    "requests": {
        "total": 15234,
        "concurrent": 3,
        "maxConcurrent": 18,
        "currentConcurrency": 20,
        "queueLength": 0
    },
    "concurrency": {
        "enabled": true,
        "current": 20,
        "adaptive": true,
        "keepAlive": true,
        "performance": {
            "avgResponseTime": 1250,
            "successRate": 0.95,
            "adjustmentCount": 3,
            "lastAdjustment": 1729441200000
        }
    },
    "ipv6": {
        "total": 100,
        "totalRequests": 15234,
        "avgPerIP": 152,
        "balance": 45,
        "successRate": 99.12,
        "totalSuccess": 15100,
        "totalFailure": 134,
        "avgResponseTime": 245,
        "uptime": 86400,
        "qps": 12.45,
        "hasIPv6": true
    },
    "system": {
        "cpu": {
            "usage": 25.5,
            "cores": 4
        },
        "memory": {
            "used": 1024,
            "total": 8192,
            "usage": 12.5
        },
        "network": {
            "rx": 1048576,
            "tx": 524288
        },
        "uptime": 86400
    },
    "health": {
        "status": 200,
        "message": "正常（原始 IPv4）",
        "lastCheck": 1729441234567
    },
    "utlsHealth": {
        "status": "healthy",
        "message": "正常 (成功率: 95%, 请求数: 15234)",
        "lastCheck": 1729441234000
    },
    "emergencyStop": false,
    "emergencyStopReason": ""
}
```

**字段说明**:
- `version`: 服务器版本号
- `clients`: 当前连接的客户端数量
- `requests.total`: 累计请求总数
- `requests.concurrent`: 当前并发请求数
- `requests.currentConcurrency`: 当前配置的并发数
- `concurrency.enabled`: 动态并发调节是否启用
- `concurrency.adaptive`: 自适应并发是否启用
- `concurrency.keepAlive`: HTTP Keep-Alive 是否启用
- `concurrency.performance`: 性能指标（响应时间、成功率等）
- `ipv6.successRate`: 成功率（百分比）
- `ipv6.qps`: 每秒请求数
- `system.cpu.usage`: CPU 使用率（百分比）
- `health.status`: 健康状态码（200=正常, 403=拉黑）
- `utlsHealth.status`: uTLS 代理健康状态
- `emergencyStop`: 紧急停止标志

#### 2.2.2 获取 IPv6 详细统计

**端点**: `GET /api/ipv6`

**响应示例**:
```json
{
    "timestamp": 1729441234567,
    "total": 100,
    "items": [
        {
            "address": "2607:8700:5500:2943::1001",
            "requests": 245,
            "success": 243,
            "failure": 2,
            "successRate": 99.18,
            "avgRT": 234,
            "lastUsed": "2分钟前"
        },
        {
            "address": "2607:8700:5500:2943::1002",
            "requests": 238,
            "success": 237,
            "failure": 1,
            "successRate": 99.58,
            "avgRT": 221,
            "lastUsed": "1分钟前"
        }
        // ... 最多返回 100 个
    ]
}
```

**排序**: 按请求数降序

#### 2.2.3 导出历史统计

**端点**: `GET /api/stats/export`

**查询参数**:
- `limit` (可选): 返回记录数限制，默认 1000，最大 100000

**响应示例**:
```json
{
    "items": [
        {
            "ts": 1729441234567,
            "stats": {
                "totalClients": 5,
                "fetcherStats": { "totalRequests": 15234 },
                "system": { "cpu": { "usage": 25.5 } }
            }
        }
    ]
}
```

#### 2.2.4 获取错误日志

**端点**: `GET /api/errorLogs`

**响应示例**:
```json
{
    "timestamp": 1729441234567,
    "total": 15,
    "logs": [
        {
            "requestId": 12345,
            "url": "https://kh.google.com/rt/earth/BulkMetadata/pb=!1m2...",
            "ipv6": "2607:8700:5500:2943::1",
            "statusCode": 429,
            "success": false,
            "duration": 5234,
            "size": 0,
            "waitTime": 12,
            "error": "Too Many Requests",
            "timestamp": 1729441234567
        }
        // ... 最多返回 50 条
    ]
}
```

### 2.3 配置管理 API

#### 2.3.1 获取配置

**端点**: `GET /api/config`

**请求头**:
- `X-Webhook-Secret: {密钥}` 或 `X-Secret: {密钥}`

**响应示例**:
```json
{
    "server": {
        "rpc": {
            "port": 9527,
            "timeout": 30000
        },
        "monitor": {
            "port": 9528
        }
    },
    "utls": {
        "proxyPort": 8765,
        "concurrency": 20,
        "enableKeepAlive": true,
        "enableAdaptiveConcurrency": true,
        "adaptiveConcurrency": {
            "adjustmentInterval": 30000,
            "minConcurrency": 5,
            "maxConcurrency": 300,
            "responseTimeThreshold": 2000,
            "successRateThreshold": 0.8
        }
    },
    "ipv6": {
        "prefix": "2607:8700:5500:2943",
        "start": 1001,
        "count": 100
    },
    "dataValidation": { "minResponseSize": 50, "allowedContentTypes": ["image/", "application/octet-stream"] }
}
```

#### 2.3.2 更新配置

**端点**: `POST /api/config`

**请求头**:
- `Content-Type: application/json`
- `X-Webhook-Secret: {密钥}` 或 `X-Secret: {密钥}`

**请求体** (单条更新):
```json
{
    "path": "utls.concurrency",
    "value": 30
}
```

**请求体** (批量更新):
```json
{
    "updates": [
        { "path": "utls.concurrency", "value": 30 },
        { "path": "utls.enableKeepAlive", "value": true },
        { "path": "utls.enableAdaptiveConcurrency", "value": true },
        { "path": "utls.adaptiveConcurrency.maxConcurrency", "value": 200 }
    ]
}
```

**响应示例**:
```json
{ "success": true }
```

**错误响应**:
```json
{ "error": "Unauthorized" }
{ "error": "Invalid JSON body" }
{ "error": "No updates provided" }
{ "error": "Invalid update item: missing path" }
{ "error": "并发数无效: 500（必须在 1-300 之间）" }
```

**配置验证**:
- 配置更新前会进行预验证
- 验证失败会自动回滚到更新前状态
- 支持原子性批量更新

**注意**: 大部分配置支持热更新，无需重启

### 2.4 日志查看 API

#### 2.4.1 实时日志

**端点**: `GET /api/logs?lines={行数}&level={级别}`

**参数**:
- `lines`: 返回最近N行（默认100，最大10000）
- `level`: 日志级别（可选：all/info/warn/error）

**请求示例**:
```bash
# 获取最近200行所有日志
curl "http://节点:9528/api/logs?lines=200&level=all"

# 只看错误日志
curl "http://节点:9528/api/logs?lines=100&level=error"
```

**响应示例**:
```json
{
    "lines": [
        {
            "timestamp": "2025-10-20T10:30:45.123Z",
            "level": "info",
            "message": "RPC 服务器已启动",
            "meta": { "port": 9527 }
        },
        {
            "timestamp": "2025-10-20T10:30:50.456Z",
            "level": "warn",
            "message": "并发数已调整",
            "meta": { "old": 20, "new": 26 }
        }
    ]
}
```

### 2.5 服务控制 API

#### 2.5.1 重新加载配置

**端点**: `POST /api/service/reload-config`

**请求头**:
- `X-Secret: {密钥}`

**响应示例**:
```json
{ "success": true, "message": "配置已重新加载" }
```

#### 2.5.2 重启服务

**端点**: `POST /api/service/restart`

**请求头**:
- `X-Secret: {密钥}`

**响应示例**:
```json
{
    "success": true,
    "message": "服务重启命令已接收，请使用 PM2 或系统服务管理器重启"
}
```

**注意**: 此端点仅触发配置重新加载，实际重启需要 PM2：
```bash
pm2 restart zeromaps-rpc
```

### 2.6 数据获取 API

#### 2.6.1 通过 HTTP 获取数据

**端点**: `GET /api/fetch?uri={uri}`

**参数**:
- `uri`: 请求的 URI（不含域名）

**请求示例**:
```bash
curl "http://tile0.zeromaps.cn:9528/api/fetch?uri=BulkMetadata/pb=!1m2!1s04!2u2699"
```

**响应**:
- **成功**: 返回 protobuf 二进制数据
- **失败**: 返回 JSON 错误信息

**响应头**:
```
Content-Type: application/octet-stream
Content-Length: 12345
```

### 2.5 IP 池状态 API

**端点**: `GET /api/ip-pool`

**响应示例**:
```json
{
    "kh.google.com": {
        "domain": "kh.google.com",
        "activeIPCount": 8,
        "blacklistedIPCount": 2,
        "totalRequests": 15234,
        "successRequests": 15100,
        "failedRequests": 134,
        "successRate": "99.12%",
        "averageResponseTime": "245ms",
        "lastProbe": "2025-10-20T10:30:45Z",
        "preferIPv6": true,
        "activeIPs": [
            {
                "ip": "2607:f8b0:4005:80a::200e",
                "totalRequests": 1892,
                "successfulRequests": 1888,
                "failedRequests": 4,
                "consecutiveFails": 0,
                "lastUsed": "2025-10-20T10:35:12Z",
                "averageResponseTime": "235ms"
            }
            // ... 其他 IP
        ]
    },
    "earth.google.com": {
        // ... 类似结构
    }
}
```

---

## 3. WebSocket API

### 3.1 WebSocket 概述

**端点**: `ws://节点:9528/ws`  
**协议**: WebSocket  
**消息格式**: JSON

### 3.2 连接流程

```javascript
const ws = new WebSocket('ws://tile0.zeromaps.cn:9528/ws')

ws.onopen = () => {
    console.log('✓ WebSocket 已连接')
}

ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    console.log('收到消息:', msg.type)
}

ws.onerror = (error) => {
    console.error('WebSocket 错误:', error)
}

ws.onclose = () => {
    console.log('✗ WebSocket 断开')
}
```

### 3.3 消息类型

#### 3.3.1 统计推送 (stats)

**方向**: 服务器 → 客户端  
**频率**: 每秒一次

**消息格式**:
```json
{
    "type": "stats",
    "data": {
        "version": "2.3.27",
        "timestamp": 1729441234567,
        "clients": 5,
        "requests": {
            "total": 15234,
            "concurrent": 3,
            "maxConcurrent": 18,
            "queueLength": 0
        },
        "ipv6": {
            "total": 100,
            "successRate": 99.12,
            "qps": 12.45
        },
        "system": {
            "cpu": { "usage": 25.5 },
            "memory": { "usage": 12.5 }
        },
        "health": {
            "status": 200,
            "message": "正常"
        }
    }
}
```

#### 3.3.2 请求日志 (requestLog)

**方向**: 服务器 → 客户端  
**触发**: 每次请求完成

**消息格式**:
```json
{
    "type": "requestLog",
    "data": {
        "requestId": 12345,
        "url": "https://kh.google.com/rt/earth/BulkMetadata/pb=...",
        "ipv6": "2607:8700:5500:2943::1",
        "statusCode": 200,
        "success": true,
        "duration": 234,
        "size": 12345,
        "waitTime": 5,
        "requestMode": "ip-pool",
        "usedIP": "2607:f8b0:4005:80a::200e",
        "timestamp": 1729441234567
    }
}
```

**字段说明**:
- `requestMode`: 请求模式
  - `ip-pool`: 使用 IP 池（95%）
  - `domain`: 使用域名（5%，刺探新 IP）
- `usedIP`: 实际使用的 IP 地址
- `waitTime`: 队列等待时间（毫秒）
- `duration`: 总耗时（毫秒）

#### 3.3.3 错误日志 (errorLog)

**方向**: 服务器 → 客户端  
**触发**: 请求失败时

**消息格式**:
```json
{
    "type": "errorLog",
    "data": {
        "requestId": 12346,
        "url": "https://kh.google.com/rt/earth/NodeData/pb=...",
        "ipv6": "2607:8700:5500:2943::2",
        "statusCode": 429,
        "success": false,
        "duration": 5234,
        "size": 0,
        "error": "Too Many Requests",
        "timestamp": 1729441234567
    }
}
```

#### 3.3.4 心跳 (ping/pong)

**方向**: 客户端 → 服务器 / 服务器 → 客户端

**Ping 请求**:
```json
{
    "type": "ping"
}
```

**Pong 响应**:
```json
{
    "type": "pong"
}
```

#### 3.3.5 数据请求 (fetch)

**方向**: 客户端 → 服务器

**请求消息**:
```json
{
    "type": "fetch",
    "id": "unique-request-id",
    "uri": "BulkMetadata/pb=!1m2!1s04!2u2699"
}
```

**响应消息（成功）**:
```json
{
    "type": "response",
    "id": "unique-request-id",
    "data": {
        "statusCode": 200,
        "data": [0x08, 0x0a, ...],  // protobuf 数组
        "headers": {}
    }
}
```

**响应消息（失败）**:
```json
{
    "type": "error",
    "id": "unique-request-id",
    "error": "Request failed"
}
```

### 3.4 IP 池同步

#### 3.4.1 请求 IP 池 (request_ip_pool)

**方向**: 客户端 → 服务器

```json
{
    "type": "request_ip_pool"
}
```

**响应**:
```json
{
    "type": "ip_pool_data",
    "data": {
        "kh.google.com": {
            "activeIPs": [...],
            "blacklistedIPs": {...}
        }
    }
}
```

#### 3.4.2 更新 IP 池 (update_ip_pool)

**方向**: 客户端 → 服务器

```json
{
    "type": "update_ip_pool",
    "data": {
        "kh.google.com": {
            "activeIPs": [...],
            "blacklistedIPs": {...}
        }
    }
}
```

**响应**:
```json
{
    "type": "ip_pool_updated"
}
```

---

## 4. Go uTLS Proxy API

### 4.1 API 概述

**基础 URL**: `http://localhost:8765`  
**用途**: 内部使用（Node.js 服务调用）  
**认证**: 无

### 4.2 代理请求

**端点**: `GET /proxy?url={url}&ipv6={ipv6}`

**参数**:
- `url`: 目标 URL（必填）
  - 格式: `https://kh.google.com/rt/earth/...`
  - 白名单: `kh.google.com`, `earth.google.com`, `www.google.com`
- `ipv6`: IPv6 地址（可选）
  - 格式: `2607:8700:5500:2943::1001`
  - 如果不提供，使用默认网络

**请求示例**:
```bash
curl "http://localhost:8765/proxy?url=https://kh.google.com/rt/earth/BulkMetadata/pb=!1m2!1s04!2u2699&ipv6=2607:8700:5500:2943::1001"
```

**响应头**:
```
HTTP/1.1 200 OK
Content-Type: application/octet-stream
X-Status-Code: 200
X-Duration-Ms: 234
X-Browser-Profile: Chrome 133 (Windows 11)
X-Request-Mode: ip-pool
X-Used-IP: 2607:f8b0:4005:80a::200e
X-Origin-Content-Type: application/x-protobuf
X-Origin-Content-Length: 12345
```

**响应头说明**:
- `X-Status-Code`: 原始 HTTP 状态码
- `X-Duration-Ms`: 请求耗时（毫秒）
- `X-Browser-Profile`: 使用的浏览器指纹
- `X-Request-Mode`: 请求模式（`ip-pool` 或 `domain`）
- `X-Used-IP`: 实际使用的 IP 地址
- `X-Origin-*`: 原始响应头（带前缀）

**错误响应**:
```json
{
    "error": "IPv6 circuit breaker open",
    "statusCode": 503
}
```

### 4.3 健康检查

**端点**: `GET /health`

**响应示例**:
```json
{
    "status": "ok",
    "version": "2.3.3",
    "uptime": 86400,
    "totalRequests": 15234,
    "successRequests": 15100,
    "failedRequests": 134,
    "successRate": "99.12%",
    "errors": {
        "error403": 5,
        "error429": 12,
        "error503": 3,
        "error5xx": 8,
        "timeout": 15,
        "network": 91
    },
    "session": {
        "totalSessions": 100,
        "totalCookies": 300,
        "oldestRefresh": "2025-10-20T08:30:45Z",
        "earliestExpiry": "2025-10-21T08:30:45Z",
        "cookieValidSeconds": 82800,
        "sessionRefreshCount": 45
    },
    "clientPool": {
        "ipv6ClientsCached": 100
    },
    "concurrencyControl": {
        "currentMaxConcurrent": 5,
        "activeRefreshCount": 2,
        "minConcurrent": 2,
        "maxConcurrent": 50
    },
    "browserProfiles": {
        "available": 15,
        "usage": {
            "Chrome 133 (Windows 11)": 3245,
            "Chrome 131 (Windows 10)": 2987,
            "Firefox 120 (Windows 10)": 1543
        }
    }
}
```

### 4.4 IP 池状态

**端点**: `GET /ip-pool`

**响应示例**:
```json
{
    "kh.google.com": {
        "domain": "kh.google.com",
        "activeIPCount": 8,
        "blacklistedIPCount": 2,
        "totalRequests": 15234,
        "successRequests": 15100,
        "failedRequests": 134,
        "successRate": "99.12%",
        "averageResponseTime": "245ms",
        "lastProbe": "2025-10-20T10:30:45Z",
        "preferIPv6": true,
        "activeIPs": [
            {
                "ip": "2607:f8b0:4005:80a::200e",
                "totalRequests": 1892,
                "successfulRequests": 1888,
                "failedRequests": 4,
                "consecutiveFails": 0,
                "lastUsed": "2025-10-20T10:35:12Z",
                "averageResponseTime": "235ms"
            }
        ],
        "blacklistedIPs": {
            "142.250.80.46": {
                "blacklistedAt": "2025-10-20T10:20:00Z",
                "reason": "Consecutive fails: 3"
            }
        }
    }
}
```

---

## 5. 客户端 SDK

### 5.1 RPC 客户端 (TypeScript)

#### 5.1.1 安装

```bash
npm install zeromaps-rpc
```

#### 5.1.2 快速开始

```typescript
import { RpcClient } from 'zeromaps-rpc/client'

// 创建客户端
const client = new RpcClient('tile0.zeromaps.cn', 9527)

// 连接到服务器
await client.connect()

// 请求数据
const response = await client.fetchData('BulkMetadata/pb=!1m2!1s04!2u2699')

console.log(`状态码: ${response.statusCode}`)
console.log(`数据大小: ${response.data.length} bytes`)

// 关闭连接
await client.disconnect()
```

#### 5.1.3 错误处理

```typescript
try {
    const response = await client.fetchData(uri)
    
    if (response.statusCode === 200) {
        // 处理数据
        processData(response.data)
    } else if (response.statusCode === 403) {
        console.error('节点被拉黑，请切换到其他节点')
    } else if (response.statusCode === 404) {
        console.warn('数据不存在')
    } else if (response.statusCode === 429) {
        console.warn('限流，请稍后重试')
    } else {
        console.error(`请求失败: ${response.statusCode}`)
    }
} catch (error) {
    console.error('网络错误:', error)
}
```

#### 5.1.4 连接管理

```typescript
class RpcClient {
    // 连接到服务器
    public async connect(): Promise<void>
    
    // 断开连接
    public async disconnect(): Promise<void>
    
    // 发送数据请求
    public async fetchData(uri: string, dataType?: DataType): Promise<DataResponse>
    
    // 监听事件
    public on(event: 'connected' | 'disconnected' | 'error', handler: Function): void
}
```

**事件**:
```typescript
client.on('connected', () => {
    console.log('已连接到服务器')
})

client.on('disconnected', () => {
    console.log('已断开连接')
})

client.on('error', (error) => {
    console.error('客户端错误:', error)
})
```

### 5.2 WebSocket 客户端 (TypeScript)

#### 5.2.1 快速开始

```typescript
import { WsClient } from 'zeromaps-rpc/client'

// 创建 WebSocket 客户端
const ws = new WsClient('tile0.zeromaps.cn', 9528)

// 连接到服务器
await ws.connect()

// 监听统计推送
ws.on('stats', (data) => {
    console.log('服务器统计:', data)
})

// 监听请求日志
ws.on('requestLog', (log) => {
    console.log('请求日志:', log)
})

// 请求数据
const response = await ws.fetch('BulkMetadata/pb=!1m2!1s04!2u2699')
console.log('响应:', response)

// 关闭连接
await ws.disconnect()
```

#### 5.2.2 事件监听

```typescript
class WsClient {
    // 监听统计推送（每秒一次）
    public on(event: 'stats', handler: (data: any) => void): void
    
    // 监听请求日志
    public on(event: 'requestLog', handler: (log: any) => void): void
    
    // 监听错误日志
    public on(event: 'errorLog', handler: (log: any) => void): void
    
    // 监听连接状态
    public on(event: 'connected' | 'disconnected' | 'error', handler: Function): void
}
```

---

## 6. 错误码

### 6.1 HTTP 状态码

| 状态码 | 说明 | 处理方式 |
|--------|------|----------|
| **200** | 成功 | 正常处理数据 |
| **400** | 请求错误 | 检查 URI 格式 |
| **403** | 节点被拉黑 / 紧急停止 | 切换到其他节点 |
| **404** | 数据不存在 | 跳过该数据 |
| **429** | 限流 | 降低请求频率，稍后重试 |
| **500** | 服务器内部错误 | 重试或联系管理员 |
| **502** | 网关错误 | uTLS 代理不可用，重试 |
| **503** | 服务不可用 | 熔断器打开，等待恢复 |

### 6.2 RPC 错误码

| 错误码 | 说明 | 处理方式 |
|--------|------|----------|
| **0** | 网络错误 | 检查网络连接，重试 |
| **1** | 握手失败 | 检查服务器状态 |
| **2** | 请求超时 | 增加超时时间，重试 |
| **3** | 连接断开 | 重新连接 |
| **4** | 协议错误 | 升级客户端版本 |

### 6.3 自定义错误消息

**紧急停止**:
```
服务已停止：节点被 Google 拉黑（403）
```

**熔断器打开**:
```
IPv6 circuit breaker open
```

**无效 URI**:
```
无效的请求 URI
```

**域名不在白名单**:
```
域名不在白名单中: example.com
```

---

## 附录

### A. Protobuf 完整定义

```protobuf
syntax = "proto3";

package zeromaps;

// 帧类型
enum FrameType {
    HANDSHAKE_REQUEST = 0;
    HANDSHAKE_RESPONSE = 1;
    DATA_REQUEST = 2;
    DATA_RESPONSE = 3;
}

// 数据类型
enum DataType {
    UNKNOWN = 0;
    BULKMETADATA = 1;
    NODEDATA = 2;
    IMAGERY = 3;
}

// 握手请求
message HandshakeRequest {
    string clientInfo = 1;
}

// 握手响应
message HandshakeResponse {
    uint32 clientID = 1;
    bool success = 2;
    string message = 3;
}

// 数据请求
message DataRequest {
    uint32 clientID = 1;
    string uri = 2;
    DataType dataType = 3;
}

// 数据响应
message DataResponse {
    uint32 clientID = 1;
    string uri = 2;
    bytes data = 3;
    uint32 statusCode = 4;
}
```

### B. 环境变量

**Node.js 服务**:
- `IPV6_PREFIX`: IPv6 前缀（如 `2607:8700:5500:2943`）
- `NODE_ENV`: 环境（`production` / `development`）
- `LOG_LEVEL`: 日志级别（`error` / `warn` / `info` / `debug`）

**Go uTLS Proxy**:
- `UTLS_PROXY_PORT`: 代理端口（默认 `8765`）
- `UTLS_CONCURRENCY`: 并发数（默认 `20`）
- `UTLS_MAX_RETRIES`: 最大重试次数（默认 `3`）
- `UTLS_REQUEST_TIMEOUT`: 请求超时（秒，默认 `30`）
- `UTLS_LOG_FILE`: 日志文件路径

### C. 请求限制

| 限制项 | 值 | 说明 |
|--------|-----|------|
| **最大并发请求** | 20 | uTLS 代理并发数 |
| **请求超时** | 30s | 单个请求超时时间 |
| **最大重试次数** | 3 | 失败后重试次数 |
| **URI 最大长度** | 1024 | 请求 URI 最大长度 |
| **响应体最大大小** | 无限制 | 自动流式传输 |

---

## 🧭 错误语义分层（增强）

为避免混淆，将错误分为三层并在响应中显式区分：

- transportStatus（传输/代理层）：
  - 由 uTLS 代理返回的网络/连接/超时等错误（例如 0、502、503）
- upstreamStatus（上游/Google）：
  - 原始上游 HTTP 状态（200、403、404、429、5xx）
- applicationStatus（应用/RPC 层）：
  - 协议/参数/服务内部错误（400、500、自定义错误码）

建议在 `DataResponse.data` 为错误时使用 JSON 返回：
```json
{
  "error": true,
  "applicationStatus": 403,
  "upstreamStatus": 403,
  "transportStatus": 200,
  "message": "服务已停止：节点被拉黑",
  "hint": "切换节点或等待自动恢复",
  "timestamp": 1729441234567
}
```

---

## ⛔ 速率限制与接口约束（增强）

为保障稳定性，建议对以下接口施加默认约束（可在反向代理或服务端实现）：

- HTTP API：
  - `/api/stats`：每 IP 每秒最多 2 次
  - `/api/errorLogs`：每 IP 每 5 秒 1 次（分页可选）
  - `/api/fetch`：仅用于调试，不建议对公网开放
- WebSocket：
  - 最大并发连接数（默认 50）
  - 推送频率：在高负载下降采样或按变化驱动
- 数据大小约束：
  - 单次响应最大 50MB（超出则分片或拒绝）

---

## 🚨 紧急停止返回规范（增强）

当节点进入“紧急停止”（例如上游 403）时：

- RPC 层 `DataResponse`：
  - `statusCode`: 固定 403（应用层语义：服务临时不可用）
  - `data`: JSON 错误体（见下）

错误体建议：
```json
{
  "error": true,
  "code": "EMERGENCY_STOP",
  "applicationStatus": 403,
  "upstreamStatus": 403,
  "message": "服务已停止：节点被 Google 拉黑（403）",
  "recovery": {
    "auto": true,
    "nextRetrySec": 1800
  },
  "actions": [
    "switch-node",
    "reduce-rate"
  ]
}
```

客户端建议处理：
- 自动切换到其他节点
- 回退到较低请求速率
- 定时重试（指数退避）

---

**文档维护**: 本文档随代码更新，请保持同步。  
**最后更新**: 2025-10-20  
**版本**: v2.3.x

