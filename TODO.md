# ZeroMaps-RPC 项目改进计划

> 📅 创建日期：2025-10-14  
> 📝 版本：v1.0  
> 🎯 目标：分阶段改进项目，优先解决高危问题，保持API完全向后兼容

---

## 📊 项目现状分析

### 代码库概览

| 指标 | 数值 | 说明 |
|------|------|------|
| TypeScript 文件 | 17 个 | 不含 node_modules 和 dist |
| TypeScript 代码行数 | 3,750 行 | 包含注释和空行 |
| Go 文件 | 1 个 | uTLS 代理 |
| Go 代码行数 | 315 行 | 完美模拟 Chrome TLS 指纹 |
| 总代码行数 | 4,065 行 | TS + Go |
| Shell 脚本 | 4 个 | deploy.sh, update.sh 等 |
| 配置文件 | 10 个 | VPS 配置 + 系统配置 |

### 文件分布

**服务器端 (Server)：** 7 个文件，2,201 行
- `server/monitor-server.ts` - 846 行 ⚠️ 最大文件
- `server/rpc-server.ts` - 411 行
- `server/ipv6-pool.ts` - 343 行
- `server/utls-fetcher.ts` - 224 行
- `server/webhook-server.ts` - 211 行
- `server/stats-exporter.ts` - 188 行
- `server/system-monitor.ts` - 157 行
- `server/index.ts` - 172 行

**客户端 (Client)：** 3 个文件，434 行
- `client/rpc-client.ts` - 251 行
- `client/ws-client.ts` - 175 行
- `client/index.ts` - 8 行

**协议定义 (Proto)：** 1 个文件，562 行
- `proto/proto/zeromaps-rpc.ts` - 562 行（自动生成）

**测试 (Tests)：** 4 个文件，137 行 ⚠️ 非标准单元测试
- `tests/test-monitoring.ts` - 55 行
- `tests/test-connection.ts` - 31 行
- `tests/test-correct-flow.ts` - 27 行
- `tests/test-real-uri.ts` - 24 行

**示例 (Examples)：** 1 个文件，65 行
- `examples/basic-usage.ts` - 65 行

**Go 代理：** 1 个文件，315 行
- `utls-proxy/main.go` - 315 行

### 技术栈

**运行时环境：**
- Node.js 18+
- Go 1.21.5+

**核心依赖：**
- `fastq` - 异步队列，用于并发控制
- `ws` - WebSocket 服务器
- `protobufjs` / `@bufbuild/protobuf` - Protocol Buffers
- `uuid` - UUID 生成

**开发工具：**
- TypeScript 5.6 (strict mode 未完全启用)
- tsx - TypeScript 执行器
- ts-proto - Protobuf 代码生成

**Go 依赖：**
- `github.com/refraction-networking/utls` - TLS 指纹模拟
- `golang.org/x/net/http2` - HTTP/2 支持

### 架构设计评估

**✅ 优点：**
1. **模块化清晰** - 服务器/客户端/协议分离良好
2. **面向对象** - 严格遵循 OOP 原则，使用 Class
3. **职责分离** - 每个类单一职责
4. **uTLS 集成** - 成功绕过 Google 检测
5. **实时监控** - WebSocket 推送很优秀

**⚠️ 问题：**
1. **资源管理** - 存在内存泄漏风险
2. **错误处理** - 不够健壮，缺少重试机制
3. **类型安全** - 存在 `any` 类型滥用
4. **测试覆盖** - 0% 单元测试覆盖率
5. **日志系统** - 使用 console.log，缺少结构化日志
6. **安全性** - Webhook Secret 可选，不够安全
7. **配置管理** - 硬编码常量散落各处

---

## 🔴 问题清单（按严重程度分类）

### 阶段一：高优先级问题（必须修复）⭐⭐⭐⭐⭐

#### 1. 资源泄漏风险

**严重程度：** 🔴 严重  
**影响范围：** 内存泄漏、服务崩溃  
**修复优先级：** P0（最高）

**问题详情：**

1. **WebSocket interval 未清理**
   - 文件：`server/monitor-server.ts:74-113`
   - 问题：每个 WebSocket 连接创建 interval，但 close 事件可能不触发
   - 影响：长期运行导致大量 interval 堆积，内存泄漏
   
2. **多个 setInterval 无 cleanup**
   - 文件：`server/index.ts:56-87`（统计打印）
   - 文件：`server/index.ts:112-115`（导出统计）
   - 问题：没有保存 interval ID，无法在关闭时清理
   - 影响：进程无法优雅退出
   
3. **pending requests 未超时清理**
   - 文件：`client/rpc-client.ts:27`
   - 问题：`pendingRequests` Map 中的请求可能永久保留
   - 影响：客户端内存泄漏

4. **事件监听器未移除**
   - 文件：`server/rpc-server.ts:74-81`
   - 问题：fetcher 的 'request' 事件监听器可能累积
   - 影响：EventEmitter 内存泄漏

**受影响文件：**
- `server/monitor-server.ts`
- `server/index.ts`
- `server/rpc-server.ts`
- `client/rpc-client.ts`

**工作量评估：** 2-3 天

**解决方案：**
1. 创建资源管理类，统一管理所有 interval/timeout
2. 在 stop() 方法中清理所有资源
3. 使用 AbortController 管理异步操作
4. 添加资源泄漏检测工具

**验收标准：**
- [ ] 所有 interval/timeout 都有对应的 clear
- [ ] WebSocket 断开时正确清理资源
- [ ] 使用 `node --trace-warnings` 无内存泄漏警告
- [ ] 连续运行 24 小时内存稳定

---

#### 2. 错误处理机制不完善

**严重程度：** 🔴 严重  
**影响范围：** 服务稳定性、数据丢失  
**修复优先级：** P0（最高）

**问题详情：**

1. **静默错误**
   - 文件：`server/stats-exporter.ts:49-52`
   - 问题：exportToTemp 静默失败，错误被完全忽略
   - 影响：无法发现潜在问题
   
2. **错误只打印不处理**
   - 文件：`server/rpc-server.ts:157-160`
   - 问题：handleFrame 错误只 console.error，不重试
   - 影响：请求丢失，客户端超时
   
3. **缺少错误恢复**
   - 文件：`server/utls-fetcher.ts:139-167`
   - 问题：fetch 失败直接返回错误，不重试
   - 影响：临时网络问题导致请求失败
   
4. **全局错误处理不足**
   - 文件：`server/index.ts:11-21`
   - 问题：uncaughtException 只打印，不退出也不恢复
   - 影响：进程可能处于不可预知状态

**受影响文件：**
- `server/stats-exporter.ts`
- `server/rpc-server.ts`
- `server/utls-fetcher.ts`
- `server/webhook-server.ts`
- `server/index.ts`

**工作量评估：** 3-4 天

**解决方案：**
1. 创建统一的错误处理类 `ErrorHandler`
2. 实现指数退避重试机制
3. 添加错误分类（可重试/不可重试）
4. 实现熔断器模式（Circuit Breaker）
5. 添加错误监控和告警

**验收标准：**
- [ ] 所有异步操作都有 try-catch
- [ ] 关键操作有重试机制（最多 3 次）
- [ ] 错误有明确的日志级别
- [ ] 严重错误触发告警

---

#### 3. 安全性问题

**严重程度：** 🟠 高  
**影响范围：** 系统安全、数据安全  
**修复优先级：** P0（最高）

**问题详情：**

1. **Webhook Secret 可选**
   - 文件：`server/webhook-server.ts:21-22`
   - 问题：Secret 可以为空，跳过签名验证
   - 影响：任何人都可以触发自动更新，存在安全隐患
   
2. **缺少请求速率限制**
   - 文件：`server/rpc-server.ts`
   - 问题：没有 rate limiting，容易被 DDoS
   - 影响：服务器资源耗尽
   
3. **输入参数未验证**
   - 文件：`server/monitor-server.ts:296-337`
   - 文件：`server/webhook-server.ts:69-153`
   - 问题：直接使用用户输入，没有验证
   - 影响：可能的注入攻击

4. **敏感信息泄露**
   - 文件：多处 console.log
   - 问题：可能打印敏感信息（如 Cookie）
   - 影响：日志泄露敏感数据

**受影响文件：**
- `server/webhook-server.ts`
- `server/rpc-server.ts`
- `server/monitor-server.ts`
- `utls-proxy/main.go`

**工作量评估：** 2-3 天

**解决方案：**
1. 强制要求 Webhook Secret（环境变量必填）
2. 实现 rate limiting（使用 express-rate-limit 或自定义）
3. 添加输入验证（使用 zod 或 joi）
4. 脱敏日志输出
5. 添加安全响应头

**验收标准：**
- [ ] Webhook Secret 为空时服务器拒绝启动
- [ ] API 有速率限制（如 100 req/min）
- [ ] 所有用户输入都经过验证
- [ ] 日志不包含敏感信息

---

#### 4. 测试覆盖率为零

**严重程度：** 🟠 高  
**影响范围：** 代码质量、可维护性  
**修复优先级：** P1

**问题详情：**

1. **无单元测试**
   - 当前测试：只有 4 个手动测试脚本
   - 问题：不是自动化单元测试，无法集成 CI/CD
   - 影响：代码变更风险高，容易引入 bug
   
2. **无集成测试**
   - 问题：缺少端到端测试
   - 影响：无法保证模块间交互正常
   
3. **无性能测试**
   - 问题：不知道系统瓶颈在哪
   - 影响：优化无从下手

**受影响文件：**
- 所有 `server/*.ts`
- 所有 `client/*.ts`

**工作量评估：** 4-5 天

**解决方案：**
1. 搭建 Vitest 测试框架
2. 编写核心类的单元测试（覆盖率 >80%）
3. 编写集成测试
4. 添加性能基准测试
5. 集成 GitHub Actions CI

**验收标准：**
- [ ] 单元测试覆盖率 >80%
- [ ] 所有核心类都有测试
- [ ] CI 自动运行测试
- [ ] PR 需通过测试才能合并

---

### 阶段二：中优先级问题（建议修复）⭐⭐⭐

#### 5. TypeScript 类型安全

**严重程度：** 🟡 中  
**影响范围：** 代码可维护性  
**修复优先级：** P2

**问题详情：**

1. **滥用 any 类型**
   - `server/rpc-server.ts:22-27` - IFetcher 接口
   - `server/rpc-server.ts:45` - requestLogs
   - `server/monitor-server.ts:18-27` - WsMessage 接口
   - 问题：丢失类型检查，容易出错
   
2. **缺少严格的接口定义**
   - 问题：很多函数参数使用宽泛的类型
   - 影响：IDE 提示不准确
   
3. **strictNullChecks 未启用**
   - 文件：`tsconfig.json`
   - 问题：可能出现 undefined/null 错误
   - 影响：运行时错误

**受影响文件：**
- `server/rpc-server.ts`
- `server/monitor-server.ts`
- `server/utls-fetcher.ts`
- `client/rpc-client.ts`

**工作量评估：** 3-4 天

**解决方案：**
1. 为所有数据结构定义明确的 interface
2. 替换所有 any 为具体类型
3. 启用 strictNullChecks
4. 使用类型守卫（type guards）

**验收标准：**
- [ ] 代码中无 any 类型（除必要情况）
- [ ] tsconfig.json 启用 strict 模式
- [ ] tsc --noEmit 无错误

---

#### 6. 日志系统升级

**严重程度：** 🟡 中  
**影响范围：** 可观测性、问题排查  
**修复优先级：** P2

**问题详情：**

1. **使用 console.log**
   - 问题：所有文件都用 console.log/error
   - 影响：日志级别混乱，无法过滤
   
2. **缺少结构化日志**
   - 问题：日志格式不统一
   - 影响：难以解析和分析
   
3. **无日志轮转**
   - 问题：日志文件无限增长
   - 影响：磁盘空间耗尽

**受影响文件：**
- 所有 `.ts` 文件

**工作量评估：** 2-3 天

**解决方案：**
1. 集成 Pino 日志库
2. 定义日志级别：debug, info, warn, error
3. 统一日志格式（JSON）
4. 配置日志轮转（pino-pretty 用于开发）

**验收标准：**
- [ ] 所有 console.log 替换为 logger
- [ ] 日志支持 JSON 格式
- [ ] 生产环境日志自动轮转
- [ ] 可配置日志级别

---

#### 7. 配置管理优化

**严重程度：** 🟡 中  
**影响范围：** 部署便利性  
**修复优先级：** P2

**问题详情：**

1. **硬编码端口号**
   - `server/index.ts:24-26`
   - 问题：PORT、MONITOR_PORT、WEBHOOK_PORT 硬编码
   - 影响：无法灵活配置
   
2. **配置分散**
   - 问题：环境变量、配置文件、硬编码混杂
   - 影响：配置混乱，难以管理
   
3. **缺少配置验证**
   - 问题：错误的配置直到运行时才发现
   - 影响：启动失败，难以排查

**受影响文件：**
- `server/index.ts`
- `server/utls-fetcher.ts`
- `server/webhook-server.ts`

**工作量评估：** 2 天

**解决方案：**
1. 创建 Config 类，集中管理配置
2. 使用环境变量替代硬编码
3. 添加配置默认值
4. 启动时验证配置

**验收标准：**
- [ ] 无硬编码的端口号和地址
- [ ] 所有配置通过环境变量或配置类
- [ ] 错误配置时启动失败并提示

---

### 阶段三：低优先级问题（持续优化）⭐⭐

#### 8. 性能优化

**严重程度：** 🟢 低  
**影响范围：** 性能提升  
**修复优先级：** P3

**问题详情：**

1. **IPv6 池初始化开销大**
   - `server/ipv6-pool.ts:29-43`
   - 问题：一次性创建 100 个对象
   - 改进：延迟初始化，按需创建
   
2. **缺少缓存机制**
   - 问题：重复计算统计数据
   - 改进：缓存计算结果

**工作量评估：** 2-3 天

**解决方案：**
1. 实现 Lazy Initialization
2. 添加 LRU 缓存
3. 优化热点代码

**验收标准：**
- [ ] 启动时间减少 20%
- [ ] 内存占用减少 10%

---

#### 9. 并发控制优化

**严重程度：** 🟢 低  
**影响范围：** 资源利用  
**修复优先级：** P3

**问题详情：**

1. **processBuffer 无并发限制**
   - `server/rpc-server.ts:141-167`
   - 问题：异步处理帧没有限制
   - 改进：添加并发队列

**工作量评估：** 2 天

**解决方案：**
1. 统一使用 fastq 管理并发
2. 实现背压机制

**验收标准：**
- [ ] 高负载下不会 OOM
- [ ] 并发数可配置

---

#### 10. 文档完善

**严重程度：** 🟢 低  
**影响范围：** 可维护性  
**修复优先级：** P3

**问题详情：**

1. **缺少 API 文档**
2. **缺少架构图**
3. **代码注释不足**

**工作量评估：** 3-4 天

**解决方案：**
1. 使用 TypeDoc 生成 API 文档
2. 绘制架构图（使用 draw.io）
3. 添加 JSDoc 注释

**验收标准：**
- [ ] API 文档自动生成
- [ ] README 包含架构图
- [ ] 核心类有完整注释

---

## 📅 实施路线图

### 总体计划（6周）

```
项目改进时间线
================================================================================

第1周：资源管理 + 错误处理
├─ Day 1-2: 修复资源泄漏
│  ├─ 创建 ResourceManager 类
│  ├─ 重构 monitor-server.ts
│  ├─ 重构 index.ts
│  └─ 添加资源清理测试
│
├─ Day 3-4: 统一错误处理
│  ├─ 创建 ErrorHandler 类
│  ├─ 实现重试机制
│  ├─ 添加错误分类
│  └─ 重构所有 catch 块
│
└─ Day 5: 代码审查
   ├─ Code Review
   ├─ 修复发现的问题
   └─ 更新文档

第2周：安全加固 + 测试框架
├─ Day 1-2: 安全性改进
│  ├─ 强制 Webhook Secret
│  ├─ 实现 Rate Limiting
│  ├─ 添加输入验证
│  └─ 日志脱敏
│
├─ Day 3-5: 测试框架搭建
│  ├─ 安装 Vitest
│  ├─ 配置测试环境
│  ├─ 编写核心类测试
│  └─ 设置 CI/CD
│
└─ Weekend: 集成测试
   ├─ 端到端测试
   └─ 性能基准测试

第3周：TypeScript 严格模式 + 日志系统
├─ Day 1-3: 类型安全改进
│  ├─ 定义所有接口
│  ├─ 消除 any 类型
│  └─ 启用 strict 模式
│
└─ Day 4-5: 日志系统升级
   ├─ 集成 Pino
   ├─ 替换 console.log
   └─ 配置日志轮转

第4周：配置管理
├─ Day 1-2: 配置重构
│  ├─ 创建 Config 类
│  ├─ 整理硬编码
│  └─ 添加配置验证
│
└─ Day 3-5: 测试和优化
   ├─ 补充单元测试
   ├─ 性能测试
   └─ 文档更新

第5周：性能优化
├─ Day 1-2: IPv6 池优化
├─ Day 3-4: 缓存机制
└─ Day 5: 并发控制优化

第6周：文档和收尾
├─ Day 1-2: API 文档
├─ Day 3: 架构图
├─ Day 4: 代码注释
└─ Day 5: 最终审查

================================================================================
```

### 里程碑

- **Milestone 1** (Week 2): 高优先级问题全部修复
- **Milestone 2** (Week 4): 中优先级问题全部修复
- **Milestone 3** (Week 6): 项目全面优化完成

---

## 📋 详细任务清单

### 任务 1：修复资源泄漏

**受影响文件：**
- `server/monitor-server.ts`
- `server/index.ts`
- `server/rpc-server.ts`
- `client/rpc-client.ts`

**子任务：**

1. **创建 ResourceManager 类** (4h)
   ```typescript
   // server/resource-manager.ts (新建)
   export class ResourceManager {
     private intervals: Set<NodeJS.Timeout>
     private timeouts: Set<NodeJS.Timeout>
     private cleanup: Array<() => void>
     
     public addInterval(id: NodeJS.Timeout): void
     public addTimeout(id: NodeJS.Timeout): void
     public registerCleanup(fn: () => void): void
     public cleanupAll(): void
   }
   ```

2. **重构 MonitorServer** (4h)
   - 保存所有 interval ID
   - 在 stop() 方法中清理
   - WebSocket close 时确保清理

3. **重构 server/index.ts** (2h)
   - 保存 setInterval 返回值
   - SIGINT/SIGTERM 时清理所有资源

4. **重构 RpcClient** (3h)
   - pending requests 超时自动清理
   - 使用 WeakMap 避免内存泄漏

5. **添加测试** (3h)
   - 测试资源正确清理
   - 测试内存不泄漏（使用 memwatch）

**预估工作量：** 16 小时 (2 天)

**验收标准：**
- [ ] 所有 setInterval/setTimeout 都被追踪
- [ ] stop() 方法清理所有资源
- [ ] 运行 24 小时无内存泄漏
- [ ] 测试覆盖率 >90%

---

### 任务 2：统一错误处理

**受影响文件：**
- 所有 `server/*.ts` 文件
- `client/rpc-client.ts`

**子任务：**

1. **创建 ErrorHandler 类** (6h)
   ```typescript
   // server/error-handler.ts (新建)
   export enum ErrorType {
     NETWORK_ERROR,
     VALIDATION_ERROR,
     BUSINESS_ERROR,
     FATAL_ERROR
   }
   
   export class ErrorHandler {
     public async retry<T>(
       fn: () => Promise<T>,
       options: RetryOptions
     ): Promise<T>
     
     public classify(error: Error): ErrorType
     public shouldRetry(error: Error): boolean
     public logError(error: Error): void
   }
   ```

2. **实现重试机制** (4h)
   - 指数退避算法
   - 最多重试 3 次
   - 支持自定义重试策略

3. **重构所有 catch 块** (8h)
   - UTLSFetcher 添加重试
   - RpcServer 错误恢复
   - WebhookServer 错误处理

4. **添加错误监控** (4h)
   - 错误统计
   - 严重错误告警（预留接口）

5. **编写测试** (4h)
   - 重试逻辑测试
   - 错误分类测试

**预估工作量：** 26 小时 (3-4 天)

**验收标准：**
- [ ] 所有异步操作有 try-catch
- [ ] 网络错误自动重试
- [ ] 严重错误有明确日志
- [ ] 测试覆盖率 >85%

---

### 任务 3：安全性加固

**受影响文件：**
- `server/webhook-server.ts`
- `server/rpc-server.ts`
- `server/monitor-server.ts`

**子任务：**

1. **强制 Webhook Secret** (2h)
   ```typescript
   // server/webhook-server.ts
   constructor(port: number, secret?: string) {
     if (!secret && !process.env.WEBHOOK_SECRET) {
       throw new Error('WEBHOOK_SECRET is required')
     }
     this.secret = secret || process.env.WEBHOOK_SECRET!
   }
   ```

2. **实现 Rate Limiting** (6h)
   ```typescript
   // server/rate-limiter.ts (新建)
   export class RateLimiter {
     public checkLimit(clientId: string): boolean
     public reset(clientId: string): void
   }
   ```
   - 基于 Token Bucket 算法
   - 每分钟 100 请求限制
   - 超限返回 429

3. **添加输入验证** (4h)
   - 使用 Zod 定义 schema
   - 验证所有 API 参数
   - 防止注入攻击

4. **日志脱敏** (2h)
   - Cookie 不完整打印
   - 敏感信息用 *** 替代

5. **编写安全测试** (4h)
   - 测试 Secret 验证
   - 测试 Rate Limiting
   - 测试输入验证

**预估工作量：** 18 小时 (2-3 天)

**验收标准：**
- [ ] Secret 为空时拒绝启动
- [ ] API 有速率限制
- [ ] 输入参数都经过验证
- [ ] 日志无敏感信息

---

### 任务 4：搭建测试框架

**受影响文件：**
- 新建 `vitest.config.ts`
- 新建 `server/**/*.spec.ts`
- 新建 `client/**/*.spec.ts`
- 新建 `.github/workflows/ci.yml`

**子任务：**

1. **安装 Vitest** (1h)
   ```bash
   npm install -D vitest @vitest/ui
   npm install -D @types/node
   ```

2. **配置测试环境** (2h)
   ```typescript
   // vitest.config.ts
   export default {
     test: {
       globals: true,
       environment: 'node',
       coverage: {
         provider: 'v8',
         reporter: ['text', 'json', 'html']
       }
     }
   }
   ```

3. **编写核心类测试** (16h)
   - IPv6Pool.spec.ts (4h)
   - UTLSFetcher.spec.ts (4h)
   - RpcServer.spec.ts (4h)
   - RpcClient.spec.ts (4h)

4. **集成测试** (6h)
   - 完整请求流程测试
   - WebSocket 通信测试

5. **设置 CI/CD** (3h)
   ```yaml
   # .github/workflows/ci.yml
   name: CI
   on: [push, pull_request]
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v3
         - uses: actions/setup-node@v3
         - run: npm ci
         - run: npm test
         - run: npm run build
   ```

**预估工作量：** 28 小时 (4-5 天)

**验收标准：**
- [ ] 测试覆盖率 >80%
- [ ] CI 自动运行测试
- [ ] PR 需测试通过才能合并
- [ ] 测试文档完善

---

### 任务 5-10：详细计划

由于篇幅限制，任务 5-10 的详细子任务将在实施时展开，这里列出关键要点：

**任务 5：TypeScript 类型安全** (3-4 天)
- 定义所有接口
- 消除 any 类型
- 启用 strict 模式

**任务 6：日志系统升级** (2-3 天)
- 集成 Pino
- 统一日志格式
- 配置日志轮转

**任务 7：配置管理优化** (2 天)
- 创建 Config 类
- 整理硬编码
- 添加配置验证

**任务 8：性能优化** (2-3 天)
- IPv6 池延迟初始化
- 添加缓存机制

**任务 9：并发控制优化** (2 天)
- 统一并发策略
- 实现背压机制

**任务 10：文档完善** (3-4 天)
- 生成 API 文档
- 绘制架构图
- 补充代码注释

---

## ⚠️ 风险评估

### 1. API 兼容性风险

**风险：** 重构可能破坏现有 API

**应对策略：**
- 保持所有 public 方法签名不变
- 只重构内部实现
- 添加弃用警告而不是直接删除
- 充分的测试覆盖

**回滚方案：**
- 使用 Git tag 标记每个版本
- 保留最近 3 个版本的备份
- 提供快速回滚脚本

### 2. 性能回退风险

**风险：** 添加功能可能降低性能

**应对策略：**
- 建立性能基准测试
- 每次改动都运行基准测试
- 性能下降 >10% 需要优化

**监控指标：**
- 请求响应时间
- 内存使用量
- CPU 使用率
- QPS 吞吐量

### 3. 部署风险

**风险：** 新版本可能无法正常部署

**应对策略：**
- 灰度发布（先1个节点，再全部）
- 自动化健康检查
- 部署失败自动回滚

**健康检查：**
```bash
# 检查端口
curl -f http://localhost:9528/api/stats

# 检查内存
pm2 list | grep zeromaps-rpc

# 检查日志
pm2 logs zeromaps-rpc --lines 50
```

### 4. 依赖升级风险

**风险：** 新增依赖可能带来兼容性问题

**应对策略：**
- 使用固定版本号（不用 ^）
- 新增依赖需要评审
- 定期检查安全漏洞

---

## 📊 成功指标

### 代码质量指标

| 指标 | 当前值 | 目标值 | 测量方法 |
|------|--------|--------|----------|
| 单元测试覆盖率 | 0% | >80% | Vitest coverage |
| TypeScript strict | ❌ | ✅ | tsconfig.json |
| ESLint 错误 | ? | 0 | eslint . |
| 资源泄漏 | ⚠️ | 0 | node --trace-warnings |
| any 类型数量 | ~15 | 0 | 手动统计 |

### 性能指标

| 指标 | 当前值 | 目标值 | 说明 |
|------|--------|--------|------|
| QPS | 10-15 | ≥10 | 不能下降 |
| 响应时间 | 150-300ms | <500ms | P99 |
| 内存使用 | ~85MB | <100MB | 稳定运行 |
| 启动时间 | ~3s | <5s | 可接受 |

### 安全指标

| 指标 | 状态 | 目标 |
|------|------|------|
| Webhook Secret | 可选 ⚠️ | 必填 ✅ |
| Rate Limiting | 无 ❌ | 有 ✅ |
| 输入验证 | 部分 ⚠️ | 全部 ✅ |
| 敏感信息泄露 | 有 ⚠️ | 无 ✅ |

### 可维护性指标

| 指标 | 状态 | 目标 |
|------|------|------|
| API 文档 | 无 ❌ | 有 ✅ |
| 架构图 | 无 ❌ | 有 ✅ |
| 代码注释 | 少 ⚠️ | 充分 ✅ |
| CI/CD | 无 ❌ | 有 ✅ |

---

## 🔄 版本管理

### 版本号规则

遵循现有的 `version-increment` 规范：

```
v2.0.12 (当前) → v2.0.13, v2.0.14, ...
```

每完成一个任务，patch 版本 +1。

### 里程碑版本

- `v2.1.0` - 阶段一完成（高优先级问题全部修复）
- `v2.2.0` - 阶段二完成（中优先级问题全部修复）
- `v3.0.0` - 阶段三完成（全面优化完成）

### Git 提交规范

```bash
# 格式
<type>: <description> (v<version>)

# 示例
git commit -m "fix: 修复WebSocket资源泄漏 (v2.0.13)"
git commit -m "feat: 添加统一错误处理 (v2.0.14)"
git commit -m "test: 添加IPv6Pool单元测试 (v2.0.15)"
```

---

## 📝 注意事项

### 开发规范

1. **不破坏 API 兼容性** - 所有改动必须向后兼容
2. **充分测试** - 每个功能都要有测试覆盖
3. **代码审查** - 重要改动需要 Code Review
4. **文档同步** - 代码改动同步更新文档

### 部署规范

1. **灰度发布** - 先在一个节点测试
2. **监控指标** - 关注性能和错误率
3. **快速回滚** - 出问题立即回滚
4. **版本标记** - 每次部署打 Git Tag

### 文档规范

1. **不创建额外 .md** - 除了 TODO.md
2. **更新 README** - 重要改进记录在 README
3. **代码注释** - 复杂逻辑必须有注释
4. **JSDoc** - 公共 API 必须有文档

---

## 📅 下一步行动

### 立即开始（本周）

1. **创建 ResourceManager** - 修复资源泄漏
2. **重构 MonitorServer** - 清理 interval
3. **添加资源清理测试** - 验证修复效果

### 本月目标

- ✅ 完成阶段一：高优先级问题全部修复
- ✅ 发布 v2.1.0 版本
- ✅ 测试覆盖率达到 80%

### 季度目标

- ✅ 完成所有三个阶段
- ✅ 发布 v3.0.0 版本
- ✅ 项目质量全面提升

---

## 📞 联系和反馈

如有任何问题或建议，请：
1. 在项目中提 Issue
2. 更新此 TODO.md
3. 在团队会议中讨论

---

**最后更新：** 2025-10-14  
**负责人：** 开发团队  
**审核人：** 待定  
**状态：** 📋 计划中

---


