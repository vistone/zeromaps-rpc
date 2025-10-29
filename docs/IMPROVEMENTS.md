# ZeroMaps RPC 改进实施方案

> **创建日期**: 2025-10-20  
> **状态**: 待实施  
> **优先级**: 🔴 高优先级优先

## 📋 目录

- [立即修复项](#立即修复项-1-2天)
- [短期改进项](#短期改进项-1-2周)
- [热更新配置支持](#热更新配置支持)
- [可配置化改进](#可配置化改进)
- [实施步骤](#实施步骤)

---

## 立即修复项 (1-2天)

### 🔴 1. 修复：配置参数未被使用

**问题**: `config/default.json` 中的 `ipv6.healthCheck.*` 配置定义了但代码中硬编码

**影响**: 用户无法通过配置调整健康检查阈值

**修改文件**: `server/ipv6-pool.ts`

**当前代码**:
```typescript
// server/ipv6-pool.ts:96-111 (硬编码)
const healthyAddresses = this.addresses.filter(addr => {
    const stats = this.detailedStats.get(addr)!
    
    // 1. 被拉黑的IP直接排除（403次数超过5次）
    if (stats.isBlacklisted || stats.error403Count >= 5) {  // ← 硬编码 5
        return false
    }
    
    // 2. 新IP给机会（少于20次请求）
    if (stats.totalRequests < 20) return true  // ← 硬编码 20
    
    const failRate = stats.failureCount / stats.totalRequests
    const avgRT = stats.totalResponseTime / stats.totalRequests
    
    // 3. 失败率<30% 且 平均响应时间<3000ms
    const tooManyRateLimits = stats.error429Count > stats.totalRequests * 0.2
    
    return failRate < 0.3 && avgRT < 3000 && !tooManyRateLimits  // ← 硬编码 0.3, 3000
})
```

**改进代码**:
```typescript
// server/ipv6-pool.ts
import { getConfig } from './config-manager.js'

export class IPv6Pool {
    private config: any
    
    constructor(basePrefix: string, start: number, count: number) {
        // 获取配置实例
        this.config = getConfig()
        
        // ... 原有初始化代码
    }
    
    public getHealthyNext(): string | null {
        if (this.addresses.length === 0) {
            return null
        }
        
        // 从配置读取阈值
        const max403Count = this.config.get<number>('ipv6.healthCheck.max403Count') || 5
        const failureRateThreshold = this.config.get<number>('ipv6.healthCheck.failureRateThreshold') || 0.3
        const responseTimeThreshold = this.config.get<number>('ipv6.healthCheck.responseTimeThreshold') || 3000
        const minRequestsBeforeCheck = this.config.get<number>('ipv6.healthCheck.minRequestsBeforeCheck') || 20
        const rateLimitThreshold = this.config.get<number>('ipv6.healthCheck.rateLimitThreshold') || 0.2
        
        const healthyAddresses = this.addresses.filter(addr => {
            const stats = this.detailedStats.get(addr)!
            
            // 1. 被拉黑的IP直接排除（使用配置的阈值）
            if (stats.isBlacklisted || stats.error403Count >= max403Count) {
                return false
            }
            
            // 2. 新IP给机会（使用配置的最小请求数）
            if (stats.totalRequests < minRequestsBeforeCheck) {
                return true
            }
            
            const failRate = stats.failureCount / stats.totalRequests
            const avgRT = stats.totalResponseTime / stats.totalRequests
            
            // 3. 使用配置的失败率和响应时间阈值
            const tooManyRateLimits = stats.error429Count > stats.totalRequests * rateLimitThreshold
            
            return failRate < failureRateThreshold && 
                   avgRT < responseTimeThreshold && 
                   !tooManyRateLimits
        })
        
        // ... 原有逻辑
    }
}
```

**配置文件更新**:
```json
// config/default.json
{
    "ipv6": {
        "healthCheck": {
            "max403Count": 5,                  // 最大 403 次数
            "failureRateThreshold": 0.3,       // 失败率阈值（30%）
            "responseTimeThreshold": 3000,     // 响应时间阈值（毫秒）
            "minRequestsBeforeCheck": 20,      // 最小请求数
            "rateLimitThreshold": 0.2          // 限流阈值（20%）
        }
    }
}
```

**工作量**: 2 小时

**价值**: ⭐⭐⭐⭐⭐ 让配置真正生效

---

### 🔴 2. 修复：数据验证阈值硬编码

**问题**: 数据验证阈值 (50B) 硬编码在代码中

**修改文件**: `server/utls-fetcher.ts`

**当前代码**:
```typescript
// server/utls-fetcher.ts:148
if (actualBodySize < 50) {  // ← 硬编码
    isValidData = false
    dataWarning = `数据过小（${actualBodySize}B），疑似错误页面`
}
```

**改进代码**:
```typescript
// server/utls-fetcher.ts
export class UTLSFetcher extends EventEmitter {
    private config: any
    
    constructor(ipv6Pool?: IPv6Pool, concurrency: number = 100, proxyPort: number = 8765) {
        super()
        this.config = getConfig()
        // ... 原有代码
    }
    
    private async worker(task: UTLSTask): Promise<FetchResult> {
        // ... 前面的代码
        
        // 从配置读取验证阈值
        const minValidDataSize = this.config.get<number>('validation.minValidDataSize') || 50
        const maxSmallDataSize = this.config.get<number>('validation.maxSmallDataSize') || 100
        
        let isValidData = true
        let dataWarning = ''
        
        if (actualBodySize < maxSmallDataSize) {
            const preview = result.body.toString('utf-8').substring(0, 50)
            
            if (preview.includes('<html') || preview.includes('<!DOCTYPE')) {
                isValidData = false
                dataWarning = '返回了 HTML 页面，不是 protobuf 数据'
            } else if (preview.includes('{') && preview.includes('"error"')) {
                isValidData = false
                dataWarning = '返回了 JSON 错误消息'
            } else if (actualBodySize < minValidDataSize) {
                isValidData = false
                dataWarning = `数据过小（${actualBodySize}B），疑似错误页面`
            }
        }
        
        // ... 后面的代码
    }
}
```

**配置文件更新**:
```json
// config/default.json
{
    "validation": {
        "minValidDataSize": 50,      // 最小有效数据大小（字节）
        "maxSmallDataSize": 100,     // 小数据阈值（需要检查的大小）
        "enableDataValidation": true  // 是否启用数据验证
    }
}
```

**工作量**: 1 小时

**价值**: ⭐⭐⭐⭐ 提升灵活性

---

### 🔴 3. 新增：配置变更提示

**问题**: 配置更新后，用户不知道是否需要重启

**修改文件**: `server/config-manager.ts`

**改进代码**:
```typescript
export class ConfigManager extends EventEmitter {
    // 需要重启才能生效的配置项
    private readonly RESTART_REQUIRED_CONFIGS = new Set([
        'server.rpc.port',
        'server.monitor.port',
        'server.webhook.port',
        'utls.proxyPort',
        'ipv6.prefix',
        'ipv6.start',
        'ipv6.count'
    ])
    
    // 可以热更新的配置项
    private readonly HOT_RELOAD_CONFIGS = new Set([
        'logging.level',
        'ipv6.healthCheck.failureRateThreshold',
        'ipv6.healthCheck.max403Count',
        'validation.minValidDataSize'
    ])
    
    public async set(path: string, value: any): Promise<{
        success: boolean
        requiresRestart: boolean
        hotReloadable: boolean
        message: string
    }> {
        try {
            // 更新配置
            const keys = path.split('.')
            let target: any = this.config
            for (let i = 0; i < keys.length - 1; i++) {
                if (!(keys[i] in target)) {
                    target[keys[i]] = {}
                }
                target = target[keys[i]]
            }
            target[keys[keys.length - 1]] = value
            
            // 验证配置
            this.validateConfig(this.config)
            
            // 保存到节点配置文件
            await this.saveNodeConfig()
            
            const requiresRestart = this.RESTART_REQUIRED_CONFIGS.has(path)
            const hotReloadable = this.HOT_RELOAD_CONFIGS.has(path)
            
            let message = '配置已更新'
            if (requiresRestart) {
                message += '，需要重启服务: pm2 restart zeromaps-rpc'
            } else if (hotReloadable) {
                message += '，已自动生效'
                // 触发热更新事件
                this.emit('hot-reload', { path, value })
            } else {
                message += '，需要重启服务以应用变更'
            }
            
            logger.info('配置已更新', { path, value, requiresRestart, hotReloadable })
            this.emit('config-changed', this.config)
            
            return {
                success: true,
                requiresRestart,
                hotReloadable,
                message
            }
        } catch (error) {
            logger.error('配置更新失败', error as Error)
            return {
                success: false,
                requiresRestart: false,
                hotReloadable: false,
                message: (error as Error).message
            }
        }
    }
}
```

**工作量**: 2 小时

**价值**: ⭐⭐⭐⭐⭐ 极大提升用户体验

---

## 短期改进项 (1-2周)

### 🟡 4. 新增：性能追踪工具

**目标**: 精确测量每个请求的各阶段耗时

**新增文件**: `server/performance-tracer.ts`

```typescript
/**
 * 性能追踪工具
 * 用于分析请求各阶段的耗时
 */

export interface Checkpoint {
    name: string
    time: number
    delta: number
}

export interface PerformanceTrace {
    requestId: number
    startTime: number
    endTime: number
    totalDuration: number
    checkpoints: Checkpoint[]
}

export class PerformanceTracer {
    private traces = new Map<number, {
        startTime: number
        checkpoints: Array<{ name: string, time: number }>
    }>()
    private enabled: boolean
    
    constructor(enabled: boolean = false) {
        this.enabled = enabled
    }
    
    /**
     * 开始追踪
     */
    public start(requestId: number): void {
        if (!this.enabled) return
        
        this.traces.set(requestId, {
            startTime: Date.now(),
            checkpoints: []
        })
    }
    
    /**
     * 记录检查点
     */
    public checkpoint(requestId: number, name: string): void {
        if (!this.enabled) return
        
        const trace = this.traces.get(requestId)
        if (!trace) return
        
        trace.checkpoints.push({
            name,
            time: Date.now()
        })
    }
    
    /**
     * 结束追踪并返回结果
     */
    public end(requestId: number): PerformanceTrace | null {
        if (!this.enabled) return null
        
        const trace = this.traces.get(requestId)
        if (!trace) return null
        
        this.traces.delete(requestId)
        
        const endTime = Date.now()
        const startTime = trace.startTime
        const totalDuration = endTime - startTime
        
        // 计算每个阶段的增量时间
        const checkpoints: Checkpoint[] = []
        let lastTime = startTime
        
        for (const cp of trace.checkpoints) {
            checkpoints.push({
                name: cp.name,
                time: cp.time - startTime,
                delta: cp.time - lastTime
            })
            lastTime = cp.time
        }
        
        // 添加最后一个阶段
        checkpoints.push({
            name: '完成',
            time: totalDuration,
            delta: endTime - lastTime
        })
        
        return {
            requestId,
            startTime,
            endTime,
            totalDuration,
            checkpoints
        }
    }
    
    /**
     * 启用/禁用追踪
     */
    public setEnabled(enabled: boolean): void {
        this.enabled = enabled
    }
    
    /**
     * 格式化输出
     */
    public static format(trace: PerformanceTrace): string {
        let output = `[请求 ${trace.requestId}] 总耗时: ${trace.totalDuration}ms\n`
        
        for (const cp of trace.checkpoints) {
            const percent = (cp.delta / trace.totalDuration * 100).toFixed(1)
            output += `  ├─ ${cp.name}: ${cp.time}ms (+${cp.delta}ms, ${percent}%)\n`
        }
        
        return output
    }
}
```

**使用示例**:
```typescript
// server/utls-fetcher.ts
private tracer = new PerformanceTracer(false)  // 默认禁用

private async worker(task: UTLSTask): Promise<FetchResult> {
    const { requestId, options, ipv6 } = task
    
    this.tracer.start(requestId)
    this.tracer.checkpoint(requestId, 'IPv6 选择完成')
    
    // 构建代理 URL
    this.tracer.checkpoint(requestId, '代理 URL 构建')
    
    // 发送请求
    const result = await this.httpRequest(proxyURL.toString(), timeout)
    this.tracer.checkpoint(requestId, 'Go 代理返回')
    
    // 数据验证
    this.tracer.checkpoint(requestId, '数据验证完成')
    
    // 记录统计
    const trace = this.tracer.end(requestId)
    if (trace) {
        logger.debug(PerformanceTracer.format(trace))
    }
    
    return result
}

// 通过配置启用
config.on('config-changed', (newConfig) => {
    const enableTracing = newConfig.performance.enableTracing || false
    this.tracer.setEnabled(enableTracing)
})
```

**配置项**:
```json
{
    "performance": {
        "enableTracing": false,  // 是否启用性能追踪（影响性能）
        "traceSampleRate": 0.01  // 采样率（1% 的请求）
    }
}
```

**工作量**: 4 小时

**价值**: ⭐⭐⭐⭐⭐ 精确性能分析

---

### 🟡 5. 新增：配置预设

**目标**: 提供不同场景的配置预设

**新增目录**: `config/presets/`

**预设文件**:

```json
// config/presets/high-performance.json
{
    "comment": "高性能配置（推荐：高配服务器 4核8G+）",
    "utls": {
        "concurrency": 30
    },
    "ipv6": {
        "count": 200
    },
    "performance": {
        "maxRequestLogs": 50,
        "healthCheckInterval": 600000  // 10分钟
    }
}
```

```json
// config/presets/low-memory.json
{
    "comment": "低内存配置（推荐：2核2G 服务器）",
    "utls": {
        "concurrency": 10
    },
    "ipv6": {
        "count": 50
    },
    "performance": {
        "maxRequestLogs": 30,
        "healthCheckInterval": 600000
    }
}
```

```json
// config/presets/development.json
{
    "comment": "开发环境配置",
    "utls": {
        "concurrency": 5
    },
    "ipv6": {
        "prefix": "",
        "count": 10
    },
    "logging": {
        "level": "debug"
    },
    "performance": {
        "enableTracing": true,
        "maxRequestLogs": 200
    }
}
```

**使用方式**:
```bash
# 应用预设
cp config/presets/high-performance.json config/node-$(hostname).json
pm2 restart zeromaps-rpc
```

**工作量**: 1 小时

**价值**: ⭐⭐⭐⭐ 方便用户选择

---

## 热更新配置支持

### 🔴 6. 实现：日志级别热更新

**修改文件**: `server/index.ts`, `server/logger.ts`

**改进代码**:
```typescript
// server/logger.ts
export class Logger {
    private logger: winston.Logger
    
    public setLevel(level: string): void {
        this.logger.level = level
    }
}

const loggerInstances = new Map<string, Logger>()

export function createLogger(module: string): Logger {
    if (loggerInstances.has(module)) {
        return loggerInstances.get(module)!
    }
    
    const logger = new Logger(module)
    loggerInstances.set(module, logger)
    return logger
}

export function updateAllLogLevels(level: string): void {
    for (const logger of loggerInstances.values()) {
        logger.setLevel(level)
    }
}
```

```typescript
// server/index.ts
import { updateAllLogLevels } from './logger.js'

// 监听配置变更
config.on('config-changed', (newConfig) => {
    const oldLevel = config.get<string>('logging.level')
    const newLevel = newConfig.logging.level
    
    if (oldLevel !== newLevel) {
        updateAllLogLevels(newLevel)
        logger.info('日志级别已热更新', { 
            oldLevel, 
            newLevel,
            noRestartRequired: true 
        })
    }
})
```

**工作量**: 2 小时

**价值**: ⭐⭐⭐⭐⭐ 调试必需

---

### 🟡 7. 实现：健康检查间隔热更新

**修改文件**: `server/rpc-server.ts`

**改进代码**:
```typescript
export class RpcServer extends EventEmitter {
    private healthCheckTimer: NodeJS.Timeout | null = null
    private utlsHealthCheckTimer: NodeJS.Timeout | null = null
    
    private startHealthCheck(): void {
        const config = getConfig()
        const interval = config.get<number>('performance.healthCheckInterval')
        
        // 立即执行一次
        this.checkHealth()
        
        // 启动定时器
        this.healthCheckTimer = setInterval(() => {
            this.checkHealth()
        }, interval)
        
        // 监听配置变更
        config.on('hot-reload', ({ path, value }) => {
            if (path === 'performance.healthCheckInterval') {
                this.restartHealthCheck(value)
            }
        })
    }
    
    private restartHealthCheck(newInterval: number): void {
        // 清除旧定时器
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer)
        }
        
        // 创建新定时器
        this.healthCheckTimer = setInterval(() => {
            this.checkHealth()
        }, newInterval)
        
        logger.info('健康检查间隔已热更新', { 
            interval: newInterval,
            noRestartRequired: true 
        })
    }
}
```

**工作量**: 2 小时

**价值**: ⭐⭐⭐ 提升灵活性

---

## 可配置化改进

### 🟡 8. DNS IP 池使用率配置化

**修改文件**: `utls-proxy/dns_pool.go`

**当前代码**:
```go
// dns_pool.go:441
return count%20 != 0  // 硬编码 95%
```

**改进代码**:
```go
type DNSIPPool struct {
    // ... 现有字段
    ipPoolUsageRate float64  // IP 池使用率（0.0-1.0）
}

func NewDNSIPPool(domain string, preferIPv6 bool) *DNSIPPool {
    // 从环境变量读取使用率
    usageRate := 0.95  // 默认 95%
    if val := os.Getenv("DNS_IP_POOL_USAGE_RATE"); val != "" {
        if v, err := strconv.ParseFloat(val, 64); err == nil && v > 0 && v <= 1.0 {
            usageRate = v
        }
    }
    
    pool := &DNSIPPool{
        // ... 现有初始化
        ipPoolUsageRate: usageRate,
    }
    
    return pool
}

func (p *DNSIPPool) ShouldUseIPPool() bool {
    if !p.hasIPv6Support {
        return false
    }
    
    count := p.requestCounter.Add(1)
    
    // 动态计算阈值
    // usageRate=0.95 → threshold=20 (每20个请求1个用域名)
    // usageRate=0.90 → threshold=10 (每10个请求1个用域名)
    // usageRate=0.80 → threshold=5  (每5个请求1个用域名)
    threshold := int64(1.0 / (1.0 - p.ipPoolUsageRate))
    
    return count%threshold != 0
}
```

**环境变量**:
```bash
# ecosystem.config.cjs
env: {
    DNS_IP_POOL_USAGE_RATE: '0.90'  // 90% 使用 IP 池
}
```

**工作量**: 2 小时

**价值**: ⭐⭐⭐ 提升灵活性

---

### 🟡 9. 新增：紧急停止恢复机制

**问题**: 紧急停止后，无法自动恢复

**修改文件**: `server/rpc-server.ts`

**改进代码**:
```typescript
export class RpcServer extends EventEmitter {
    private emergencyStop = false
    private emergencyStopReason = ''
    private emergencyStopAt = 0
    private emergencyRecoveryTimer: NodeJS.Timeout | null = null
    
    private async emergencyHealthCheck(): Promise<void> {
        // ... 现有代码
        
        if (result.statusCode === 403) {
            this.emergencyStop = true
            this.emergencyStopReason = '节点被 Google 拉黑（403）'
            this.emergencyStopAt = Date.now()
            
            // 获取配置的恢复时间
            const config = getConfig()
            const recoveryTime = config.get<number>('emergencyStop.autoRecoveryTime') || 3600000  // 默认1小时
            
            // 设置自动恢复定时器
            this.emergencyRecoveryTimer = setTimeout(() => {
                this.tryRecovery()
            }, recoveryTime)
            
            logger.error('🚨 紧急停止，将在 ${recoveryTime/1000} 秒后尝试自动恢复')
        }
    }
    
    private async tryRecovery(): Promise<void> {
        logger.info('🔄 尝试从紧急停止状态恢复...')
        
        // 再次健康检查
        const result = await this.rawHttpsRequest('https://kh.google.com/rt/earth/PlanetoidMetadata', 5000)
        
        if (result.statusCode === 200) {
            // 恢复正常
            this.emergencyStop = false
            this.emergencyStopReason = ''
            
            logger.info('✅ 已恢复正常，重新接受请求')
        } else {
            // 仍然是 403，延长恢复时间
            const config = getConfig()
            const retryDelay = config.get<number>('emergencyStop.retryDelay') || 1800000  // 默认30分钟
            
            this.emergencyRecoveryTimer = setTimeout(() => {
                this.tryRecovery()
            }, retryDelay)
            
            logger.warn(`⚠️ 仍然被拉黑，将在 ${retryDelay/1000} 秒后再次尝试`)
        }
    }
}
```

**配置项**:
```json
{
    "emergencyStop": {
        "autoRecoveryTime": 3600000,   // 自动恢复时间（毫秒，默认1小时）
        "retryDelay": 1800000,         // 重试延迟（毫秒，默认30分钟）
        "maxRetries": 10               // 最大重试次数
    }
}
```

**工作量**: 3 小时

**价值**: ⭐⭐⭐⭐ 提升可用性

---

## 实施步骤

### 阶段 1: 立即修复 (第1天)

**步骤**:
1. ✅ 修改 `IPv6Pool` 读取配置参数
2. ✅ 修改 `UTLSFetcher` 读取验证阈值
3. ✅ 更新 `config/default.json` 添加缺失配置
4. ✅ 测试配置是否生效

**验证**:
```bash
# 修改配置
vim config/default.json
# 修改 ipv6.healthCheck.max403Count: 3

# 观察日志
pm2 logs zeromaps-rpc --lines 50
# 应该看到使用新的阈值 (3 而不是 5)
```

---

### 阶段 2: 热更新支持 (第2-3天)

**步骤**:
1. ✅ 实现 `ConfigManager.set()` 返回详细信息
2. ✅ 实现日志级别热更新
3. ✅ 实现健康检查间隔热更新
4. ✅ 更新 Monitor Server API 显示热更新状态

**验证**:
```bash
# 通过 API 修改配置
curl -X POST http://localhost:9528/api/config \
  -H "Content-Type: application/json" \
  -d '{"logging.level": "debug"}'

# 响应应该包含:
{
    "success": true,
    "requiresRestart": false,
    "hotReloadable": true,
    "message": "配置已更新，已自动生效"
}

# 验证日志级别已变化
pm2 logs zeromaps-rpc --lines 10
# 应该看到 debug 级别的日志
```

---

### 阶段 3: 性能追踪 (第4-5天)

**步骤**:
1. ✅ 创建 `PerformanceTracer` 类
2. ✅ 在 `UTLSFetcher` 中集成追踪
3. ✅ 在 `RpcServer` 中集成追踪
4. ✅ 添加配置开关和采样率

**验证**:
```bash
# 启用性能追踪
curl -X POST http://localhost:9528/api/config \
  -H "Content-Type: application/json" \
  -d '{"performance.enableTracing": true}'

# 查看追踪日志
pm2 logs zeromaps-rpc --lines 50

# 应该看到:
# [请求 12345] 总耗时: 234ms
#   ├─ IPv6 选择完成: 2ms (+2ms, 0.9%)
#   ├─ 代理 URL 构建: 5ms (+3ms, 1.3%)
#   ├─ Go 代理返回: 220ms (+215ms, 91.9%)
#   ├─ 数据验证完成: 228ms (+8ms, 3.4%)
#   └─ 完成: 234ms (+6ms, 2.6%)
```

---

### 阶段 4: 配置预设和紧急恢复 (第6-7天)

**步骤**:
1. ✅ 创建配置预设文件
2. ✅ 实现紧急停止自动恢复
3. ✅ 更新文档说明
4. ✅ 全面测试

---

## 附录：配置文件完整对比

### 当前 config/default.json

```json
{
    "server": { ... },
    "utls": { ... },
    "ipv6": {
        "prefix": "",
        "start": 1001,
        "count": 100,
        "healthCheck": {
            "failureRateThreshold": 0.3,      // ❌ 未使用
            "responseTimeThreshold": 3000,    // ❌ 未使用
            "minRequestsBeforeCheck": 20      // ❌ 未使用
        }
    },
    "logging": { ... },
    "performance": { ... },
    "dns": { ... },  // ❌ 整个模块未使用
    "p2p": { ... }   // ❌ 功能禁用
}
```

### 建议的完整配置

```json
{
    "server": {
        "name": "",
        "domain": "",
        "rpc": {
            "port": 9527,
            "timeout": 30000
        },
        "monitor": {
            "port": 9528,
            "statsInterval": 60000
        },
        "webhook": {
            "port": 9530,
            "secret": "",
            "updateScript": "/opt/zeromaps-rpc/auto-update.sh",
            "forwardToOtherNodes": true
        }
    },
    "utls": {
        "proxyPort": 8765,
        "concurrency": 20,
        "timeout": 10000
    },
    "ipv6": {
        "prefix": "",
        "start": 1001,
        "count": 100,
        "healthCheck": {
            "max403Count": 5,                  // ✅ 新增
            "failureRateThreshold": 0.3,       // ✅ 实际使用
            "responseTimeThreshold": 3000,     // ✅ 实际使用
            "minRequestsBeforeCheck": 20,      // ✅ 实际使用
            "rateLimitThreshold": 0.2          // ✅ 新增
        }
    },
    "validation": {                            // ✅ 新增模块
        "minValidDataSize": 50,
        "maxSmallDataSize": 100,
        "enableDataValidation": true
    },
    "emergencyStop": {                         // ✅ 新增模块
        "autoRecoveryTime": 3600000,
        "retryDelay": 1800000,
        "maxRetries": 10
    },
    "logging": {
        "level": "info",
        "maxFileSize": 10485760,
        "maxFiles": 10
    },
    "performance": {
        "maxRequestLogs": 100,
        "healthCheckInterval": 300000,
        "enableTracing": false,                // ✅ 新增
        "traceSampleRate": 0.01                // ✅ 新增
    },
    "dns": {
        // ❌ 删除（Go 代理使用环境变量）
    },
    "p2p": {
        // ❌ 删除或标注为禁用
    }
}
```

---

**文档维护**: 本文档是分析报告，不随代码更新。  
**创建时间**: 2025-10-20  
**实施状态**: 待执行

