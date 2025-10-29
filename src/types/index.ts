/**
 * 项目类型定义
 * 统一管理所有接口和类型定义
 */

// ==================== 基础类型 ====================

export interface BaseResponse {
    success: boolean
    message?: string
    timestamp: number
}

export interface ErrorResponse extends BaseResponse {
    success: false
    error: string
    code?: number
}

// ==================== 配置相关类型 ====================

export interface ServerConfig {
    server: {
        name: string
        domain: string
        rpc: {
            port: number
            timeout: number
        }
        monitor: {
            port: number
            statsInterval: number
        }
        webhook: {
            port: number
            secret: string
            updateScript: string
            forwardToOtherNodes: boolean
        }
    }
    utls: {
        proxyPort: number
        concurrency: number
        timeout: number
        enableKeepAlive?: boolean
        enableAdaptiveConcurrency?: boolean
        adaptiveConcurrency?: {
            adjustmentInterval: number
            minConcurrency: number
            maxConcurrency: number
            responseTimeThreshold: number
            successRateThreshold: number
        }
    }
    ipv6: {
        prefix: string
        start: number
        count: number
        healthCheck: {
            maxError403Count: number
            minRequestsBeforeCheck: number
            failureRateThreshold: number
            responseTimeThreshold: number
            rateLimitThreshold: number
        }
    }
    logging: {
        level: string
        maxFileSize: number
        maxFiles: number
    }
    performance: {
        maxRequestLogs: number
        healthCheckInterval: number
    }
    dns?: {
        enabled: boolean
        ipPoolFile: string
        ipPoolUsageRate: number
        probeInterval: number
        saveInterval: number
        health: {
            consecutiveFailsThreshold: number
            successRateThreshold: number
            blacklistDuration: number
            minPoolSize: number
        }
    }
    dataValidation?: {
        minResponseSize: number
    }
}

// ==================== RPC 相关类型 ====================

export interface ClientSession {
    id: number
    socket: any
    ip: string
    connectedAt: number
    requestCount: number
    lastActiveAt: number
}

export interface FetchOptions {
    url: string
    method?: string
    headers?: Record<string, string>
    timeout?: number
    ipv6?: string
}

export interface FetchResult {
    statusCode: number
    headers: Record<string, string>
    body: Buffer
    error?: string
}

// ==================== 监控相关类型 ====================

export interface SystemStats {
    cpu: {
        usage: number
        cores: number
        loadAvg: number[]
    }
    memory: {
        total: number
        used: number
        free: number
        usage: number
    }
    network: {
        rx: number
        tx: number
        rxTotal: number
        txTotal: number
    }
    uptime: number
}

export interface PerformanceMetrics {
    avgResponseTime: number
    successRate: number
    adjustmentCount: number
    lastAdjustment: number
}

export interface ConcurrencyStats {
    enabled: boolean
    current: number
    adaptive: boolean
    keepAlive: boolean
    performance: PerformanceMetrics
}

export interface ServerStats {
    totalClients: number
    fetcherType: string
    fetcherStats: any
    ipv6Stats: any
    system: SystemStats
    health: HealthStatus
    utlsHealth: HealthStatus
    emergencyStop: boolean
    emergencyStopReason: string
    dynamicConcurrency: ConcurrencyStats
}

export interface HealthStatus {
    status: number | string
    message: string
    lastCheck: number
}

// ==================== IPv6 池相关类型 ====================

export interface IPv6Address {
    address: string
    requests: number
    success: number
    failure: number
    avgResponseTime: number
    lastUsed: number
    isHealthy: boolean
    isBlacklisted: boolean
}

export interface IPv6PoolStats {
    total: number
    healthy: number
    blacklisted: number
    qps: number
    successRate: number
    totalSuccess: number
    totalFailure: number
    avgResponseTime: number
    avgPerIP: number
    balance: string
    hasIPv6: boolean
}

export interface IPv6HealthCheckConfig {
    maxError403Count: number
    minRequestsBeforeCheck: number
    failureRateThreshold: number
    responseTimeThreshold: number
    rateLimitThreshold: number
}

// ==================== 数据验证类型 ====================

export interface DataValidationConfig {
    minResponseSize: number
    allowedContentTypes?: string[]
}

// ==================== WebSocket 相关类型 ====================

export interface WsMessage {
    type: 'fetch' | 'ping' | 'request_ip_pool' | 'update_ip_pool'
    id?: string
    uri?: string
    data?: any
}

export interface WsResponse {
    type: 'response' | 'error' | 'pong' | 'stats' | 'ip_pool_data' | 'ip_pool_updated'
    id?: string
    data?: any
    error?: string
}

// ==================== 请求日志类型 ====================

export interface RequestLog {
    requestId: number
    url: string
    ipv6: string
    statusCode: number
    success: boolean
    duration: number
    size: number
    waitTime: number
    requestMode?: string
    usedIP?: string
    error?: string
    timestamp: number
}

// ==================== 配置更新类型 ====================

export interface ConfigUpdate {
    path: string
    value: any
}

export interface ConfigUpdateRequest {
    path?: string
    value?: any
    updates?: ConfigUpdate[]
}

// ==================== 导出类型 ====================

export interface StatsExportResponse {
    items: Array<{
        ts: number
        stats: ServerStats
    }>
}
