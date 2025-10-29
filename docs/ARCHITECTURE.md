# ZeroMaps RPC 技术架构文档

> **文档版本**: v2.3.x  
> **更新日期**: 2025-10-20  
> **维护者**: Stone (vistone)

## 📋 目录

- [1. 系统概述](#1-系统概述)
- [2. 架构设计](#2-架构设计)
- [3. 核心组件](#3-核心组件)
- [4. 技术实现](#4-技术实现)
- [5. 数据流](#5-数据流)
- [6. 安全机制](#6-安全机制)
- [7. 性能优化](#7-性能优化)
- [8. 可扩展性](#8-可扩展性)

---

## 1. 系统概述

### 1.1 项目定位

ZeroMaps RPC 是一个高性能的 Google Earth 数据获取系统，通过完美模拟 Chrome 浏览器指纹和智能 IPv6 地址池管理，实现对 Google Earth API 的稳定、高效访问。

### 1.2 核心价值

- ✅ **完美伪装**: 使用 Go uTLS 库完美模拟 Chrome 120/131/133 TLS 指纹
- ✅ **高可用性**: IPv6 地址池轮询 + 熔断器机制，避免单点失败
- ✅ **智能重试**: 多层级重试策略（403/429/503/5xx/超时）
- ✅ **会话管理**: 自动 Cookie 刷新机制，保持长期有效会话
- ✅ **分布式部署**: 支持多节点部署，Webhook 自动更新
- ✅ **DNS 优化**: IP 池缓存，减少 DNS 解析延迟

### 1.3 技术栈

**后端服务 (Node.js)**
- TypeScript 5.6+
- Node.js 18+
- WebSocket (ws 8.x)
- Protobuf (Protocol Buffers)
- FastQ (无锁队列)

**TLS 伪装层 (Go)**
- Go 1.24.9
- uTLS 1.8.1 (TLS 指纹模拟)
- HTTP/2 原生支持

**部署工具**
- PM2 (进程管理)
- Caddy 2.x (反向代理)
- Git (代码同步)

---

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                     客户端 (Client)                          │
│              ZeroMaps 应用 / 自定义 RPC 客户端                │
└────────────────────┬────────────────────────────────────────┘
                     │ RPC 协议 (Protobuf over TCP)
                     ↓
┌─────────────────────────────────────────────────────────────┐
│              Node.js RPC Server (端口 9527)                  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  握手管理 (Handshake)   客户端会话管理 (Sessions)     │  │
│  │  请求队列 (FastQ)        IPv6 池管理 (IPv6Pool)      │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTP (localhost:8765)
                     ↓
┌─────────────────────────────────────────────────────────────┐
│               Go uTLS Proxy (端口 8765)                      │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  浏览器指纹池 (15种)     Session 管理 (Cookie)        │  │
│  │  DNS IP 池               熔断器 (Circuit Breaker)     │  │
│  │  HTTP/2 连接池           重试机制 (Retry Logic)       │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTPS (TLS 1.2/1.3)
                     ↓
┌─────────────────────────────────────────────────────────────┐
│                Google Earth API                              │
│          kh.google.com / earth.google.com                    │
└─────────────────────────────────────────────────────────────┘

       监控层 (Monitoring Layer)
┌─────────────────────────────────────────────────────────────┐
│  Monitor Server (9528)    │  Webhook Server (9530)          │
│  - HTTP API               │  - GitHub Webhook              │
│  - WebSocket 实时推送     │  - 自动代码同步                │
│  - Web 管理面板           │  - 多节点转发                  │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 分层设计

#### 第 1 层：客户端层 (Client Layer)
- **职责**: 发起数据请求，接收响应
- **通信协议**: RPC (Protobuf over TCP)
- **组件**: RpcClient, WsClient

#### 第 2 层：RPC 服务层 (RPC Service Layer)
- **职责**: 客户端连接管理、请求调度、IPv6 地址选择
- **核心类**: RpcServer, IPv6Pool, UTLSFetcher
- **语言**: TypeScript (Node.js)

#### 第 3 层：TLS 伪装层 (TLS Impersonation Layer)
- **职责**: 完美模拟浏览器 TLS 指纹、Session 管理、DNS 优化
- **核心组件**: uTLS Proxy (Go)
- **语言**: Go 1.24.9

#### 第 4 层：目标 API 层 (Target API Layer)
- **目标**: Google Earth API
- **域名**: kh.google.com, earth.google.com

#### 第 5 层：监控层 (Monitoring Layer)
- **职责**: 实时监控、统计分析、自动更新
- **组件**: MonitorServer, WebhookServer

---

## 3. 核心组件

### 3.1 RpcServer (Node.js)

**职责**: RPC 服务器，处理客户端连接和数据请求

**核心功能**:
- 客户端握手 (Handshake)
- 会话管理 (Session Management)
- 请求分发 (Request Dispatching)
- IPv6 地址选择 (IPv6 Selection)
- 紧急停止机制 (Emergency Stop)

**关键方法**:
```typescript
class RpcServer extends EventEmitter {
  // 启动服务器
  public async start(): Promise<void>
  
  // 处理客户端连接
  private handleConnection(socket: net.Socket): void
  
  // 处理数据请求
  private async handleDataRequest(socket: net.Socket, payload: Buffer): Promise<void>
  
  // 健康检查
  private async checkHealth(): Promise<void>
  
  // 紧急健康检查（检测到可疑数据时触发）
  private async emergencyHealthCheck(): Promise<void>
}
```

**状态管理**:
- `clients: Map<number, ClientSession>` - 客户端会话映射
- `emergencyStop: boolean` - 紧急停止标志
- `healthStatus` - Google API 健康状态
- `utlsHealthStatus` - uTLS 代理健康状态

### 3.2 IPv6Pool (Node.js)

**职责**: IPv6 地址池管理，负载均衡和健康检查

**核心功能**:
- 地址轮询 (Round Robin)
- 健康评估 (Health Assessment)
- 统计记录 (Statistics Recording)
- 黑名单管理 (Blacklist Management)

**智能选择算法**:
```typescript
class IPv6Pool {
  // 获取健康的 IPv6 地址（排除失败率高的IP）
  public getHealthyNext(): string | null {
    const healthyAddresses = this.addresses.filter(addr => {
      const stats = this.detailedStats.get(addr)!
      
      // 1. 被拉黑的IP直接排除（403次数超过5次）
      if (stats.isBlacklisted || stats.error403Count >= 5) {
        return false
      }
      
      // 2. 新IP给机会（少于20次请求）
      if (stats.totalRequests < 20) return true
      
      const failRate = stats.failureCount / stats.totalRequests
      const avgRT = stats.totalResponseTime / stats.totalRequests
      
      // 3. 失败率<30% 且 平均响应时间<3000ms
      // 4. 如果429（限流）次数过多，降低优先级
      const tooManyRateLimits = stats.error429Count > stats.totalRequests * 0.2
      
      return failRate < 0.3 && avgRT < 3000 && !tooManyRateLimits
    })
    
    // 从健康IP中选择使用最少的
    // ...
  }
  
  // 记录请求结果
  public recordRequest(ipv6: string, statusCode: number, responseTime: number): void
}
```

**统计指标**:
- 总请求数 / 成功次数 / 失败次数
- 403 / 429 / 404 / 其他错误次数
- 平均响应时间 / 最小 / 最大响应时间
- 最后使用时间 / 黑名单状态

### 3.3 UTLSFetcher (Node.js)

**职责**: 通过 Go uTLS 代理发送请求

**核心功能**:
- 请求队列管理 (FastQ)
- IPv6 地址绑定
- 数据验证（检测无效数据）
- 统计收集

**工作流程**:
```typescript
class UTLSFetcher extends EventEmitter {
  private queue: queueAsPromised<UTLSTask, FetchResult>
  
  public async fetch(options: FetchOptions): Promise<FetchResult> {
    // 1. 选择 IPv6 地址（如果有）
    const ipv6 = options.ipv6 || this.ipv6Pool?.getHealthyNext()
    
    // 2. 推入队列（异步处理）
    const result = await this.queue.push({ options, ipv6 })
    
    // 3. 返回结果
    return result
  }
  
  private async worker(task: UTLSTask): Promise<FetchResult> {
    // 1. 构建代理 URL
    const proxyURL = new URL(this.proxyUrl)
    proxyURL.searchParams.set('url', options.url)
    if (ipv6) proxyURL.searchParams.set('ipv6', ipv6)
    
    // 2. 请求 Go 代理
    const result = await this.httpRequest(proxyURL.toString(), timeout)
    
    // 3. 验证数据有效性
    if (result.body.length < 50 && result.statusCode === 200) {
      // 触发紧急健康检查
      this.emit('invalidData', { statusCode, bodySize, warning })
    }
    
    // 4. 记录统计
    this.ipv6Pool?.recordRequest(ipv6, statusCode, duration)
    this.emit('request', { requestId, url, ipv6, statusCode, success, duration })
    
    return result
  }
}
```

### 3.4 Go uTLS Proxy

**职责**: TLS 指纹模拟、Session 管理、DNS 优化

**核心功能**:
1. **浏览器指纹模拟**
   - Chrome 133, 131, 120, 106, 102, 100
   - Firefox 120, 105, 102
   - Edge 106, 85
   - Safari 16.0
   - iOS 14, 13

2. **Session 管理**
   - 自动获取 Cookie (earth.google.com)
   - Cookie 过期检测和自动刷新
   - 多 IPv6 独立 Session 管理

3. **DNS IP 池**
   - 95% IP 池请求（无 DNS 解析）
   - 5% 域名请求（刺探新 IP）
   - IP 健康管理（失败自动淘汰）

4. **熔断器 (Circuit Breaker)**
   - 失败率阈值: 80%
   - 最小请求数: 20
   - 熔断时间: 5 分钟

**关键数据结构**:
```go
// Cookie 会话
type CookieSession struct {
    cookies        []*http.Cookie
    lastUpdate     time.Time
    earliestExpiry time.Time
    lastAccess     time.Time
    refreshing     atomic.Bool
    mu             sync.RWMutex
}

// IPv6 健康状态（熔断器）
type IPv6Health struct {
    totalRequests  atomic.Int64
    failedRequests atomic.Int64
    circuitOpen    atomic.Bool
    circuitOpenAt  time.Time
    mu             sync.RWMutex
}

// DNS IP 池
type DNSIPPool struct {
    domain         string
    activeIPs      []IPHealth
    blacklistedIPs map[string]time.Time
    requestCounter atomic.Int64
    preferIPv6     bool
    mu             sync.RWMutex
}
```

### 3.5 MonitorServer (Node.js)

**职责**: 实时监控、统计分析、Web 管理面板

**核心功能**:
- HTTP API (RESTful)
- WebSocket 实时推送
- Web 管理面板
- P2P 节点同步（IP 池共享）

**API 端点**:
```
GET  /api/stats         - 获取服务器统计
GET  /api/ipv6          - 获取 IPv6 详细统计
GET  /api/errorLogs     - 获取错误日志
GET  /api/config        - 获取配置
POST /api/config        - 更新配置
GET  /api/fetch?uri=xxx - 通过 HTTP API 获取数据
WS   /ws                - WebSocket 实时推送
```

### 3.6 WebhookServer (Node.js)

**职责**: GitHub Webhook 自动更新、多节点转发

**工作流程**:
```
1. GitHub Push 触发 Webhook
   ↓
2. tile0 收到 Webhook
   ↓
3. 本节点执行 auto-update.sh (nohup 后台)
   ↓
4. 并行转发到其他 6 个节点
   ↓
5. 每个节点独立执行 auto-update.sh
   ↓
6. 所有节点更新完成
```

**防止循环转发**:
- 转发的请求带有 `User-Agent: ZeroMaps-Webhook-Forwarder`
- 收到转发请求的节点不会再次转发

---

## 4. 技术实现

### 4.1 uTLS TLS 指纹模拟

**原理**: 使用 Go uTLS 库，在 TLS ClientHello 阶段完美模拟真实浏览器

**实现**:
```go
// 创建 uTLS 连接
tlsConfig := &utls.Config{
    ServerName:         "kh.google.com",
    InsecureSkipVerify: false,
    MinVersion:         tls.VersionTLS12,
    NextProtos:         []string{"h2", "http/1.1"},
}

// 使用 Chrome 133 指纹
tlsConn := utls.UClient(rawConn, tlsConfig, utls.HelloChrome_133)

// TLS 握手
err := tlsConn.Handshake()
```

**支持的浏览器指纹**:
- Chrome: 133, 131, 120, 106, 102, 100
- Firefox: 120, 105, 102
- Edge: 106, 85
- Safari: 16.0
- iOS: 14, 13

**Headers 设置**:
```go
func setHeaders(req *http.Request, profile BrowserProfile, isSessionRequest bool) {
    req.Header.Set("User-Agent", profile.UserAgent)
    req.Header.Set("Accept-Language", profile.AcceptLanguage)
    
    // Chrome/Edge 特有
    if profile.SecChUa != "" {
        req.Header.Set("Sec-Ch-Ua", profile.SecChUa)
        req.Header.Set("Sec-Ch-Ua-Mobile", "?0")
        req.Header.Set("Sec-Ch-Ua-Platform", profile.SecChUaPlatform)
    }
    
    // Session 请求特有
    if isSessionRequest {
        req.Header.Set("Sec-Fetch-Dest", "document")
        req.Header.Set("Sec-Fetch-Mode", "navigate")
        req.Header.Set("Sec-Fetch-User", "?1")
    } else {
        req.Header.Set("Referer", "https://earth.google.com/")
        req.Header.Set("Origin", "https://earth.google.com")
    }
}
```

### 4.2 Session 管理

**Cookie 获取流程**:
```
1. 访问 earth.google.com/web/ (GET)
   - 使用 uTLS 模拟浏览器
   - TLS 指纹: Chrome 120+
   ↓
2. Google 返回 Set-Cookie
   - NID (主要 Cookie)
   - 1P_JAR (会话 Cookie)
   - CONSENT (同意 Cookie)
   ↓
3. 解析并存储 Cookie
   - 计算最早过期时间
   - 保存到内存 (sessionManager)
   ↓
4. 后续请求携带 Cookie
   - 附加到 kh.google.com 请求
   - 域名匹配: .google.com
```

**刷新策略**:
```go
func needsRefresh(session *CookieSession) bool {
    // 1. 没有 Cookie，需要刷新
    if len(session.cookies) == 0 {
        return true
    }
    
    // 2. 检查是否有 Cookie 已经过期或即将过期（提前 5 分钟）
    now := time.Now()
    if !session.earliestExpiry.IsZero() && now.Add(5*time.Minute).After(session.earliestExpiry) {
        return true
    }
    
    // 3. 兜底：如果 24 小时内没有刷新过，强制刷新
    if time.Since(session.lastUpdate) > 24*time.Hour {
        return true
    }
    
    return false
}
```

**403 错误处理**:
```go
// 收到 403 → 立即强制刷新 Session
if statusCode == 403 && needsSession {
    if !hasRefreshedCookie && attempt < maxRetries {
        refreshSession(ipv6, true)  // force=true
        // 使用新 Cookie 重试
    }
}
```

### 4.3 DNS IP 池优化

**目标**: 减少 DNS 解析时间（50-200ms → 0ms）

**实现原理**:
```
传统方式:
  每次请求 → DNS 解析 (50-200ms) → 连接 → 请求 → 响应
  
优化方式:
  95% 请求 → 直接使用 IP (0ms) → 连接 → 请求 → 响应
  5% 请求 → DNS 解析 (刺探新 IP) → 连接 → 请求 → 响应
```

**IP 池结构**:
```go
type DNSIPPool struct {
    domain         string
    activeIPs      []IPHealth      // 活跃 IP 池
    blacklistedIPs map[string]time.Time  // 黑名单（10分钟清理）
    requestCounter atomic.Int64
    preferIPv6     bool
    mu             sync.RWMutex
}

type IPHealth struct {
    IP                  string
    TotalRequests       int64
    SuccessfulRequests  int64
    FailedRequests      int64
    ConsecutiveFails    int64
    LastUsed            time.Time
    AverageResponseTime time.Duration
}
```

**使用策略**:
```go
func (p *DNSIPPool) ShouldUseIPPool() bool {
    count := p.requestCounter.Add(1)
    return count%20 != 0  // 95% 使用 IP 池，5% 使用域名
}

func (p *DNSIPPool) GetRandomIP(preferIPv6 bool) string {
    // 从活跃 IP 池中随机选择
    // 优先选择 IPv6（如果 preferIPv6=true）
}
```

**健康管理**:
```go
// 连续失败 3 次 → 移入黑名单
if ipHealth.ConsecutiveFails >= 3 {
    p.blacklistedIPs[ip] = time.Now().Add(10 * time.Minute)
    p.activeIPs = removeIP(p.activeIPs, ip)
}

// 成功率 < 50% → 移入黑名单
if ipHealth.TotalRequests > 20 {
    successRate := float64(ipHealth.SuccessfulRequests) / float64(ipHealth.TotalRequests)
    if successRate < 0.5 {
        p.blacklistedIPs[ip] = time.Now().Add(10 * time.Minute)
    }
}
```

### 4.4 熔断器 (Circuit Breaker)

**目标**: 防止持续请求失败的 IPv6 地址

**实现**:
```go
func recordRequestResult(ipv6 string, success bool) {
    health := getOrCreateIPv6Health(ipv6)
    
    health.totalRequests.Add(1)
    if !success {
        health.failedRequests.Add(1)
    }
    
    total := health.totalRequests.Load()
    failed := health.failedRequests.Load()
    
    // 最少 20 个请求才触发熔断
    if total < 20 {
        return
    }
    
    // 计算失败率
    failureRate := float64(failed) / float64(total)
    
    // 失败率 > 80% → 打开熔断器
    if failureRate > 0.8 && !health.circuitOpen.Load() {
        health.circuitOpen.Store(true)
        health.circuitOpenAt = time.Now()
        
        log.Printf("⚠️ 触发熔断！失败率: %.2f%% (%d/%d)，暂停使用 5 分钟", 
            failureRate*100, failed, total)
    }
}

func isCircuitOpen(ipv6 string) bool {
    health := getOrCreateIPv6Health(ipv6)
    
    if !health.circuitOpen.Load() {
        return false
    }
    
    // 5 分钟后尝试恢复
    if time.Since(health.circuitOpenAt) > 5*time.Minute {
        // 重置计数器
        health.totalRequests.Store(0)
        health.failedRequests.Store(0)
        health.circuitOpen.Store(false)
        return false
    }
    
    return true
}
```

**状态转换**:
```
关闭 (Closed) → 失败率 > 80% → 打开 (Open)
   ↑                                  ↓
   └───── 5分钟后 + 重置计数 ──────────┘
```

### 4.5 紧急停止机制

**触发条件**:
1. 请求返回 200 状态码
2. 但数据 < 50B（疑似错误页）
3. 或者返回 HTML/JSON 错误内容

**流程**:
```typescript
// 1. UTLSFetcher 检测到无效数据
if (!isValidData && statusCode === 200) {
    this.emit('invalidData', { requestId, bodySize, warning })
}

// 2. RpcServer 收到事件，触发紧急检查
this.fetcher.on('invalidData', async (data) => {
    await this.emergencyHealthCheck()
})

// 3. 紧急健康检查（使用原始 IPv4 curl）
private async emergencyHealthCheck(): Promise<void> {
    const testUrl = 'https://kh.google.com/rt/earth/PlanetoidMetadata'
    const result = await this.rawHttpsRequest(testUrl, 5000)
    
    if (result.statusCode === 403) {
        // 确认节点被拉黑
        this.emergencyStop = true
        this.emergencyStopReason = '节点被 Google 拉黑（403）'
        
        // 拒绝所有后续请求
        this.notifyAllClients403()
    }
}

// 4. 所有后续请求被拦截
if (this.emergencyStop) {
    const errorResponse = DataResponse.encode({
        clientID: request.clientID,
        uri: request.uri,
        statusCode: 403,
        data: Buffer.from(`服务已停止：${this.emergencyStopReason}`)
    }).finish()
    
    this.sendFrame(socket, FrameType.DATA_RESPONSE, Buffer.from(errorResponse))
    return
}
```

---

## 5. 数据流

### 5.1 完整请求流程

```
[客户端] RpcClient
   │
   │ 1. 握手 (Handshake)
   ├──> HandshakeRequest { clientInfo: "..." }
   │
   │ 2. 分配 clientID
   <──┤ HandshakeResponse { clientID: 1, success: true }
   │
   │ 3. 数据请求
   ├──> DataRequest { clientID: 1, uri: "BulkMetadata/pb=!1m2..." }
   │
   ↓

[RPC服务器] RpcServer
   │
   │ 4. 检查紧急停止标志
   ├──> if (emergencyStop) → 返回 403 错误
   │
   │ 5. 验证 URI 有效性
   ├──> isValidURI(uri)
   │
   │ 6. 选择健康的 IPv6 地址
   ├──> ipv6Pool.getHealthyNext()
   │    - 排除被拉黑的 IP (403 >= 5)
   │    - 排除失败率高的 IP (>30%)
   │    - 排除限流的 IP (429 > 20%)
   │
   ↓

[UTLSFetcher] 请求队列
   │
   │ 7. 推入 FastQ 队列
   ├──> queue.push({ requestId, options, ipv6 })
   │
   │ 8. Worker 处理
   ├──> worker(task)
   │    - 构建代理 URL: http://localhost:8765/proxy?url=xxx&ipv6=xxx
   │    - 发送 HTTP 请求到 Go 代理
   │
   ↓

[Go uTLS Proxy]
   │
   │ 9. 检查熔断器状态
   ├──> if (isCircuitOpen(ipv6)) → 返回 503 错误
   │
   │ 10. 获取或创建 Session
   ├──> getOrCreateSession(ipv6)
   │    - 检查 Cookie 是否需要刷新
   │    - 如果需要，刷新 Session (访问 earth.google.com)
   │
   │ 11. 获取固定的浏览器指纹
   ├──> getBrowserProfileForIPv6(ipv6)
   │    - 每个 IPv6 固定使用一个浏览器指纹
   │
   │ 12. DNS IP 池策略
   ├──> if (ShouldUseIPPool()) {  // 95% 情况
   │        finalURL = "https://[2607:...]" + path
   │    } else {  // 5% 情况
   │        finalURL = "https://kh.google.com" + path
   │    }
   │
   │ 13. 获取或创建 HTTP/2 客户端
   ├──> if (ipv6) {
   │        client = getOrCreateIPv6Client(ipv6)
   │    } else {
   │        client = clientPool.Get()
   │    }
   │
   │ 14. 设置 Headers
   ├──> setHeaders(req, profile, false)
   │    - User-Agent: Chrome 133
   │    - Sec-Ch-Ua: "Chromium";v="133"
   │    - Referer: https://earth.google.com/
   │    - Origin: https://earth.google.com
   │
   │ 15. 添加 Cookie
   ├──> for _, cookie := range session.cookies {
   │        req.AddCookie(cookie)
   │    }
   │
   │ 16. 发送请求（支持重试）
   ├──> for attempt := 0; attempt <= maxRetries; attempt++ {
   │        resp, err = client.Do(req)
   │        
   │        if err != nil {
   │            // 网络错误 → 指数退避重试
   │            delay = baseDelay * (1 << attempt)
   │            continue
   │        }
   │        
   │        if statusCode == 403 {
   │            // 强制刷新 Cookie → 重试
   │            refreshSession(ipv6, true)
   │            continue
   │        }
   │        
   │        if statusCode == 429 {
   │            // 限流 → 更长退避 → 重试
   │            delay = baseDelay * (1 << (attempt+2))
   │            continue
   │        }
   │        
   │        if statusCode >= 500 {
   │            // 服务器错误 → 短暂等待 → 重试
   │            continue
   │        }
   │        
   │        break  // 成功或其他错误
   │    }
   │
   │ 17. 读取响应体
   ├──> body, err := io.ReadAll(resp.Body)
   │
   │ 18. 解压 gzip（如果需要）
   ├──> if resp.Header.Get("Content-Encoding") == "gzip" {
   │        body, _ = decompressGzip(body)
   │    }
   │
   │ 19. 记录统计和熔断器
   ├──> recordRequestResult(ipv6, success)
   │    stats.successRequests.Add(1)
   │    pool.RecordResult(usedIP, statusCode, duration)
   │
   │ 20. 返回响应
   └──> w.Header().Set("X-Status-Code", strconv.Itoa(statusCode))
        w.Header().Set("X-Request-Mode", "ip-pool")
        w.Header().Set("X-Used-IP", usedIP)
        w.Write(body)

   ↓

[UTLSFetcher] 验证数据
   │
   │ 21. 检查数据有效性
   ├──> if (bodySize < 50 && statusCode == 200) {
   │        // 可能是错误页面，触发紧急检查
   │        this.emit('invalidData', { ... })
   │    }
   │
   │ 22. 记录 IPv6 池统计
   ├──> ipv6Pool.recordRequest(ipv6, statusCode, duration)
   │
   │ 23. 返回结果
   └──> return { statusCode, headers, body }

   ↓

[RPC服务器] 构建响应
   │
   │ 24. 编码 Protobuf
   ├──> DataResponse.encode({
   │        clientID,
   │        uri,
   │        data: result.body,
   │        statusCode: result.statusCode
   │    })
   │
   │ 25. 发送帧
   └──> sendFrame(socket, FrameType.DATA_RESPONSE, response)

   ↓

[客户端] 接收响应
   │
   │ 26. 解码 Protobuf
   └──> DataResponse.decode(payload)
        console.log(`状态码: ${response.statusCode}, 数据: ${response.data.length} bytes`)
```

### 5.2 Session 刷新流程

```
[判断是否需要刷新]
   │
   ├─> 1. 没有 Cookie？→ 刷新
   ├─> 2. Cookie 即将过期（5分钟内）？→ 刷新
   └─> 3. 超过 24 小时未刷新？→ 刷新
   
   如果不需要刷新 → 直接返回

[并发控制]
   │
   ├─> 使用 CAS 操作防止同一 Session 并发刷新
   │   if (!session.refreshing.CompareAndSwap(false, true)) {
   │       // 其他 goroutine 正在刷新，等待完成
   │       return
   │   }
   │
   └─> 获取全局刷新槽位（动态并发数）
       sessionRefreshSem <- struct{}{}
       defer func() { <-sessionRefreshSem }()

[刷新过程]
   │
   ├─> 1. 使用 IPv6 固定的浏览器指纹
   │       profile = getBrowserProfileForIPv6(ipv6)
   │
   ├─> 2. 获取或创建 HTTP/2 客户端
   │       if (ipv6) {
   │           client = getOrCreateIPv6Client(ipv6)
   │       } else {
   │           client = clientPool.Get()
   │       }
   │
   ├─> 3. 创建请求
   │       req = GET https://earth.google.com/web/
   │       - User-Agent: Chrome 133
   │       - Accept: text/html,application/xhtml+xml,...
   │       - Sec-Fetch-Dest: document
   │       - Sec-Fetch-Mode: navigate
   │
   ├─> 4. 发送请求
   │       resp, err = client.Do(req)
   │
   ├─> 5. 提取 Cookie
   │       cookies = resp.Cookies()
   │       - NID (主要 Cookie)
   │       - 1P_JAR (会话 Cookie)
   │       - CONSENT (同意 Cookie)
   │
   ├─> 6. 计算最早过期时间
   │       for _, cookie := range cookies {
   │           if !cookie.Expires.IsZero() {
   │               if earliestExpiry.IsZero() || cookie.Expires.Before(earliestExpiry) {
   │                   earliestExpiry = cookie.Expires
   │               }
   │           }
   │       }
   │
   └─> 7. 保存到 Session
       session.cookies = cookies
       session.lastUpdate = now
       session.earliestExpiry = earliestExpiry
       session.refreshing.Store(false)
       
       log.Printf("✓ 会话已刷新，获得 %d 个 Cookie", len(cookies))
```

### 5.3 自动更新流程

```
[GitHub Push]
   │
   ↓
[Webhook Server (tile0)]
   │
   ├─> 1. 验证签名
   │       signature = SHA256-HMAC(body, secret)
   │
   ├─> 2. 检查事件类型和分支
   │       if (event != "push" || ref != "refs/heads/master") {
   │           return
   │       }
   │
   ├─> 3. 立即返回响应（不阻塞）
   │       res.writeHead(200)
   │       res.end('Update triggered')
   │
   ├─> 4. 后台触发更新
   │       this.triggerUpdate()  // 异步执行
   │
   ├─> 5. 转发到其他节点
   │       this.forwardToOtherNodes(body, headers)  // 并发转发
   │
   └─> 防止循环
       if (req.headers['user-agent'] === 'ZeroMaps-Webhook-Forwarder') {
           // 收到转发的请求，不再继续转发
       }

[triggerUpdate 流程]
   │
   ├─> 1. 设置更新标志
   │       this.updating = true
   │
   ├─> 2. 预处理：同步代码
   │       cd /opt/zeromaps-rpc
   │       git fetch origin master --tags
   │       git reset --hard origin/master
   │
   ├─> 3. 创建包装脚本
   │       const wrapperScript = '/tmp/zeromaps-update-wrapper.sh'
   │       export PATH=...
   │       export PM2_HOME=...
   │       export AUTO_UPDATE_SYNCED="1"
   │       cd /opt/zeromaps-rpc
   │       exec bash auto-update.sh
   │
   └─> 4. 使用 nohup 执行（后台）
       nohup /tmp/zeromaps-update-wrapper.sh >/dev/null 2>&1 &
       
       // 立即重置标志（2秒后）
       setTimeout(() => { this.updating = false }, 2000)

[auto-update.sh 执行]
   │
   ├─> 1. 检测本地 IP，加载 configs/vps-{IP}.conf
   │
   ├─> 2. 彻底清理所有进程
   │       pm2 delete all
   │       pkill -9 utls-proxy
   │       pkill -9 node
   │
   ├─> 3. 确认代码版本
   │       grep version package.json
   │
   ├─> 4. 检查 Go 版本
   │       if (go version != 1.24.9) {
   │           wget https://go.dev/dl/go1.24.9.linux-amd64.tar.gz
   │           tar -xzf go*.tar.gz -C /usr/local
   │       }
   │
   ├─> 5. 安装依赖
   │       npm install
   │
   ├─> 6. 编译代码
   │       npm run build  # TypeScript
   │       cd utls-proxy && bash build.sh  # Go
   │
   ├─> 7. 生成 PM2 配置
   │       cat > ecosystem.config.cjs <<EOF
   │       module.exports = {
   │         apps: [
   │           {
   │             name: 'utls-proxy',
   │             script: './utls-proxy/utls-proxy',
   │             env: { UTLS_PROXY_PORT: 8765 }
   │           },
   │           {
   │             name: 'zeromaps-rpc',
   │             script: 'node',
   │             args: 'dist/server/index.js',
   │             env: {
   │               IPV6_PREFIX: '${IPV6_PREFIX}',
   │               NODE_ENV: 'production'
   │             }
   │           }
   │         ]
   │       }
   │       EOF
   │
   └─> 8. 启动服务
       pm2 start utls-proxy (等待 3 秒)
       pm2 start zeromaps-rpc (等待 3 秒)
       pm2 save
       
       // 验证端口和健康检查
       curl http://localhost:9528/api/stats
```

---

## 6. 安全机制

### 6.1 请求验证

**URI 白名单**:
```typescript
private isValidURI(uri: string): boolean {
    // 1. URI 不能为空
    if (!uri || uri.trim().length === 0) return false
    
    // 2. 拒绝测试用的无效节点 ID
    if (uri.includes('!1s0!') || uri.includes('!2s0!')) return false
    
    // 3. 只允许特定的 API 路径
    const validPaths = [
        'PlanetoidMetadata',
        'BulkMetadata',
        'NodeData',
        'ImageryMetadata',
        'Imagery'
    ]
    
    const hasValidPath = validPaths.some(path => uri.startsWith(path))
    if (!hasValidPath) return false
    
    // 4. 检查是否包含合法的 protobuf 参数格式
    if (uri.includes('/pb=') && uri.length < 20) return false
    
    return true
}
```

**域名白名单 (Go)**:
```go
var allowedDomains = map[string]bool{
    "kh.google.com":    true,
    "earth.google.com": true,
    "www.google.com":   true,
}

func isAllowedURL(targetURL string) error {
    parsedURL, err := url.Parse(targetURL)
    if err != nil {
        return fmt.Errorf("无效的 URL: %w", err)
    }
    
    if parsedURL.Scheme != "https" {
        return fmt.Errorf("只允许 HTTPS 协议")
    }
    
    if !allowedDomains[parsedURL.Host] {
        return fmt.Errorf("域名不在白名单中: %s", parsedURL.Host)
    }
    
    return nil
}
```

### 6.2 Webhook 签名验证

**GitHub Webhook 签名**:
```typescript
private async handleWebhook(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 读取请求体
    const body = Buffer.concat(chunks)
    const payload = body.toString()
    
    // 验证签名（如果配置了 secret）
    if (this.secret) {
        const signature = req.headers['x-hub-signature-256'] as string
        if (!signature) {
            res.writeHead(401)
            res.end('Missing signature')
            return
        }
        
        const expectedSignature = 'sha256=' + crypto
            .createHmac('sha256', this.secret)
            .update(body)
            .digest('hex')
        
        if (signature !== expectedSignature) {
            res.writeHead(401)
            res.end('Invalid signature')
            return
        }
    }
    
    // 签名验证通过，处理 push 事件
    // ...
}
```

### 6.3 配置验证

**端口验证**:
```typescript
private validateConfig(config: ServerConfig): void {
    const portMap = {
        'RPC端口': config.server.rpc.port,
        '监控端口': config.server.monitor.port,
        'Webhook端口': config.server.webhook.port,
        'uTLS代理端口': config.utls.proxyPort
    }
    
    for (const [name, port] of Object.entries(portMap)) {
        if (!Number.isInteger(port) || port <= 1024 || port > 65535) {
            throw new Error(`${name}无效: ${port}（必须在 1025-65535 之间）`)
        }
    }
}
```

---

## 7. 性能优化

### 7.1 连接复用

**HTTP/2 连接池**:
- 每个 IPv6 地址创建独立的 HTTP/2 客户端
- 客户端缓存：`ipv6ClientCache.Store(ipv6, client)`
- 连接保活：`ReadIdleTimeout: 60s`, `PingTimeout: 15s`

**无 IPv6 时的连接池**:
```go
clientPool = sync.Pool{
    New: func() interface{} {
        return createUTLSClient()
    },
}

// 使用
client := clientPool.Get().(*http.Client)
defer clientPool.Put(client)
```

### 7.2 并发控制

**RPC 请求队列**:
```typescript
// 使用 FastQ 管理接收队列
this.queue = fastq.promise(this.worker.bind(this), concurrency)

// 全部接纳，不阻塞
public async fetch(options: FetchOptions): Promise<FetchResult> {
    const result = await this.queue.push(task)
    return result
}
```

**Session 刷新并发控制**:
```go
// 动态调整并发数（根据 Session 数量）
func calculateOptimalConcurrency() int32 {
    sessionCount := countSessions()
    optimal := sessionCount / 20
    
    if optimal < config.minConcurrentRefresh {
        optimal = config.minConcurrentRefresh
    }
    if optimal > config.maxConcurrentRefresh {
        optimal = config.maxConcurrentRefresh
    }
    
    return optimal
}

// 使用信号量控制
sessionRefreshSem <- struct{}{}
defer func() { <-sessionRefreshSem }()
```

### 7.3 DNS 优化

**IP 池缓存**:
- 95% 请求使用 IP 池（0ms DNS 解析）
- 5% 请求使用域名（刺探新 IP）
- 持久化到文件：`ip-pools.json`

**效果**:
```
优化前：每个请求 50-200ms DNS 解析
优化后：95% 请求 0ms DNS 解析
平均节省：47.5ms - 190ms
```

### 7.4 数据压缩

**自动 gzip 解压**:
```go
// 检查 Content-Encoding
if resp.Header.Get("Content-Encoding") == "gzip" {
    body, err = decompressGzip(body)
}

func decompressGzip(data []byte) ([]byte, error) {
    reader, err := gzip.NewReader(bytes.NewReader(data))
    if err != nil {
        return nil, err
    }
    defer reader.Close()
    return io.ReadAll(reader)
}
```

### 7.5 资源清理

**定期清理过期资源**:
```go
func startResourceCleanup() {
    ticker := time.NewTicker(5 * time.Minute)
    defer ticker.Stop()
    
    for range ticker.C {
        cleanupExpiredResources()
    }
}

func cleanupExpiredResources() {
    // 1. 清理超过 30 分钟未使用的 Session
    sessionManager.Range(func(key, value interface{}) bool {
        session := value.(*CookieSession)
        if now.Sub(session.lastAccess) > 30*time.Minute {
            sessionManager.Delete(key)
        }
        return true
    })
    
    // 2. 清理对应的 HTTP/2 客户端
    ipv6ClientCache.Range(func(key, value interface{}) bool {
        if _, exists := sessionManager.Load(key); !exists {
            ipv6ClientCache.Delete(key)
        }
        return true
    })
}
```

---

## 8. 可扩展性

### 8.1 水平扩展

**多节点部署**:
- 每个节点独立运行
- 通过 Webhook 自动同步代码
- 客户端随机选择节点连接

**负载均衡**:
```
客户端 → DNS 轮询 → 随机节点
或
客户端 → 轮询列表 → 顺序连接
```

### 8.2 垂直扩展

**配置调整**:
```json
{
    "utls": {
        "concurrency": 20  // 增加并发数（推荐 10-30）
    },
    "ipv6": {
        "count": 200  // 增加 IPv6 池大小
    }
}
```

### 8.3 功能扩展

**添加新的浏览器指纹**:
```go
// 在 browserProfiles 数组中添加
browserProfiles = append(browserProfiles, BrowserProfile{
    Name:            "Chrome 140 (Windows 11)",
    UserAgent:       "...",
    SecChUa:         "...",
    SecChUaPlatform: "Windows",
    AcceptLanguage:  "zh-CN,zh;q=0.9",
    Accept:          "...",
    ClientHello:     utls.HelloChrome_140,  // 需要 uTLS 支持
})
```

**添加新的监控指标**:
```typescript
// 在 MonitorServer 中添加新的 API 端点
private async serveCustomStats(res: http.ServerResponse): Promise<void> {
    const customStats = {
        metric1: this.calculateMetric1(),
        metric2: this.calculateMetric2()
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(customStats))
}

// 在 handleRequest 中注册路由
if (url === '/api/custom-stats') {
    await this.serveCustomStats(res)
}
```

---

## 附录

### A. 性能指标

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

### B. 端口分配

| 服务 | 端口 | 协议 | 说明 |
|------|------|------|------|
| **RPC Server** | 9527 | TCP | 客户端连接端口 |
| **Monitor Server** | 9528 | HTTP/WebSocket | 监控和管理端口 |
| **Webhook Server** | 9530 | HTTP | GitHub Webhook 端口 |
| **uTLS Proxy** | 8765 | HTTP | Go 代理端口（内部） |

### C. 配置文件

| 文件 | 用途 | 提交到 Git |
|------|------|-----------|
| `config/default.json` | 默认配置 | ✅ 是 |
| `config/node-{hostname}.json` | 节点特定配置 | ❌ 否 |
| `configs/vps-{IP}.conf` | VPS 物理配置 | ❌ 否 |
| `ecosystem.config.cjs` | PM2 配置 | ❌ 否（动态生成） |
| `utls-proxy/ip-pools.json` | DNS IP 池 | ❌ 否（运行时生成） |

### D. 日志文件

| 文件 | 内容 | 轮转 |
|------|------|------|
| `/opt/zeromaps-rpc/logs/combined.log` | 所有日志 | 自动 |
| `/opt/zeromaps-rpc/logs/error.log` | 错误日志 | 自动 |
| `/opt/zeromaps-rpc/logs/utls-proxy.log` | Go 代理日志 | 手动（100MB） |
| `/var/log/zeromaps-auto-update.log` | 自动更新日志 | 手动 |

---

**文档维护**: 本文档随代码更新，请保持同步。  
**最后更新**: 2025-10-20  
**版本**: v2.3.x

---

## ♻️ 节点健康状态机（增强）

本节明确各健康检查来源与状态切换规则，避免状态抖动。

### 状态定义
- Unknown: 初始/无数据
- Healthy: 上游/代理均正常
- Degraded: 成功率下降/响应时间升高
- Blacklisted: 原生 IPv4/上游确认 403
- Recovering: 黑名单后定时重检中

### 事件源
- 原生 IPv4 健康检查（RpcServer.checkHealth）
- uTLS 代理健康（/health）
- 数据有效性异常（200 + 小体积/HTML/JSON 错误）
- DNS IP 池健康事件（可选）

### 切换与抖动抑制（建议）
- Healthy → Degraded：连续 N 次成功率低于阈值或 P95 超阈
- Degraded → Healthy：连续 M 次恢复（M>N）
- 任意 → Blacklisted：原生 IPv4 明确 403 确认
- Blacklisted → Recovering：等待 T1（默认 1h）后重检
- Recovering → Healthy：重检 200；否则再次延长 T2（默认 30min）

所有阈值可配置：`performance.health.*`，并在日志中附带状态切换原因与冷却时间。

---

## 🔐 安全模型与攻击面（增强）

### 攻击面
- Webhook `/webhook`：当未配置 secret 时，当前逻辑仅告警但仍执行更新（风险高）
- 监控 HTTP API：若公网暴露，存在信息泄漏风险
- WebSocket 推送：高频/错误峰值下的敏感信息泄露
- 配置 API：变更范围未白名单化，误用风险

### 防护建议（生产）
- Webhook：必须配置 `server.webhook.secret`；否则拒绝（401）
- 反向代理：Caddy/Nginx 侧对 `/api/*`、`/ws` 加来源限制或 Basic/Auth
- 速率限制：为 `/api/stats`、`/api/errorLogs`、`/ws` 增加速率与并发上限（可配置）
- WebSocket 脱敏：错误日志字段采样与脱敏（URI/参数）
- 配置 API 白名单：仅允许热更新键（日志级别、健康检查间隔等）

---

## 🔄 配置热更新语义（增强）

将配置分为三类：

- Hot Reload（即时生效）：
  - `logging.level`
  - `performance.healthCheckInterval`
  - （建议）数据验证阈值、IPv6 健康阈值
- Soft Reload（需重建子组件）：
  - `utls.concurrency`（需重建队列；可“平滑切换”）
- Hard Restart（需重启进程）：
  - 监听端口（RPC/Monitor/Webhook）
  - IPv6 前缀/数量（需重建地址池）

API 响应建议结构：
```json
{
  "success": true,
  "requiresRestart": false,
  "hotReloadable": true,
  "message": "配置已更新并生效"
}
```

