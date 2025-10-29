/**
 * RPC 服务器核心
 * 处理客户端连接、请求分发、会话管理
 */

import * as net from 'net'
import { EventEmitter } from 'events'
import { ServerConfig, ClientSession, FetchOptions, FetchResult, ServerStats } from '../../types/index.js'
import { createLogger } from '../../utils/logger.js'
import { IPv6Pool } from '../../services/pool/ipv6-pool.js'
import { UTLSFetcher } from '../../services/fetcher/utls-fetcher.js'
import { SystemMonitor } from '../../monitoring/system-monitor.js'
import { PerformanceCalculator } from '../../utils/metrics.js'

const logger = createLogger('RpcServer')

export class RpcServer extends EventEmitter {
    private server: net.Server
    private clients: Map<number, ClientSession> = new Map()
    private nextClientId = 1
    private isRunning = false
    private emergencyStop = false
    private emergencyStopReason = ''

    // 核心组件
    private ipv6Pool: IPv6Pool
    private fetcher: UTLSFetcher
    private systemMonitor: SystemMonitor
    private performanceMetrics: PerformanceCalculator

    // 动态并发调节
    private dynamicConcurrencyEnabled: boolean
    private concurrencyAdjustmentInterval: NodeJS.Timeout | null = null
    private lastSystemStats: any = null

    constructor(private config: ServerConfig) {
        super()

        // 初始化IPv6池
        this.ipv6Pool = new IPv6Pool(
            config.ipv6.prefix,
            config.ipv6.start,
            config.ipv6.count,
            config.ipv6.healthCheck
        )

        // 初始化数据获取器
        this.fetcher = new UTLSFetcher(
            config.utls.proxyPort,
            config.utls.concurrency,
            config.utls.enableKeepAlive || false,
            config.utls.enableAdaptiveConcurrency || false,
            config.dataValidation || { minResponseSize: 50 }
        )

        // 初始化系统监控
        this.systemMonitor = new SystemMonitor()

        // 初始化性能指标
        this.performanceMetrics = new PerformanceCalculator()

        // 动态并发调节
        this.dynamicConcurrencyEnabled = config.utls.enableAdaptiveConcurrency || false

        // 创建TCP服务器
        this.server = net.createServer((socket) => {
            this.handleClientConnection(socket)
        })

        this.setupEventHandlers()
    }

    /**
     * 设置事件处理器
     */
    private setupEventHandlers(): void {
        this.server.on('error', (error) => {
            logger.error('RPC服务器错误', error)
            this.emit('error', error)
        })

        this.server.on('close', () => {
            logger.info('RPC服务器已关闭')
            this.emit('close')
        })

        // 监听配置变化
        this.on('config-changed', (newConfig: ServerConfig) => {
            this.updateConfig(newConfig)
        })
    }

    /**
     * 处理客户端连接
     */
    private handleClientConnection(socket: net.Socket): void {
        const clientId = this.nextClientId++
        const client: ClientSession = {
            id: clientId,
            socket,
            ip: socket.remoteAddress || 'unknown',
            connectedAt: Date.now(),
            requestCount: 0,
            lastActiveAt: Date.now()
        }

        this.clients.set(clientId, client)

        logger.info('客户端已连接', {
            clientId,
            ip: client.ip,
            totalClients: this.clients.size
        })

        // 设置socket事件处理器
        socket.on('data', (data) => {
            this.handleClientData(client, data)
        })

        socket.on('close', () => {
            this.handleClientDisconnect(client)
        })

        socket.on('error', (error) => {
            logger.warn('客户端连接错误', { clientId, error: error.message })
            this.handleClientDisconnect(client)
        })

        this.emit('client-connected', client)
    }

    /**
     * 处理客户端数据
     */
    private handleClientData(client: ClientSession, data: Buffer): void {
        try {
            client.lastActiveAt = Date.now()

            // 解析请求（这里简化处理，实际应该解析protobuf）
            const request = this.parseRequest(data)
            if (request) {
                this.handleFetchRequest(client, request)
            }
        } catch (error) {
            logger.error('处理客户端数据失败', error as Error, { clientId: client.id })
        }
    }

    /**
     * 解析请求
     */
    private parseRequest(data: Buffer): any {
        // 简化的请求解析，实际应该使用protobuf
        try {
            return JSON.parse(data.toString())
        } catch {
            return null
        }
    }

    /**
     * 处理获取请求
     */
    private async handleFetchRequest(client: ClientSession, request: any): Promise<void> {
        if (this.emergencyStop) {
            this.sendErrorResponse(client, '服务已紧急停止: ' + this.emergencyStopReason)
            return
        }

        client.requestCount++

        try {
            // 选择IPv6地址
            const ipv6 = this.ipv6Pool.getHealthyNext()

            // 构建请求选项
            const options: FetchOptions = {
                url: request.uri,
                method: request.method || 'GET',
                headers: request.headers || {},
                timeout: request.timeout || 30000,
                ipv6: ipv6 || undefined
            }

            // 发送请求
            const result = await this.fetcher.fetch(options)

            // 记录结果
            if (ipv6) {
                this.ipv6Pool.recordRequest(ipv6, result.statusCode, 0) // 简化处理
            }

            // 检查紧急停止条件
            this.checkEmergencyStop(result)

            // 发送响应
            this.sendSuccessResponse(client, result)

        } catch (error) {
            logger.error('处理获取请求失败', error as Error, {
                clientId: client.id,
                uri: request.uri
            })
            this.sendErrorResponse(client, (error as Error).message)
        }
    }

    /**
     * 检查紧急停止条件
     */
    private checkEmergencyStop(result: FetchResult): void {
        if (result.statusCode === 403 && result.body.length < 1000) {
            this.emergencyStop = true
            this.emergencyStopReason = '检测到403错误且响应数据异常'
            logger.error('触发紧急停止', new Error(this.emergencyStopReason), { reason: this.emergencyStopReason })
            this.emit('emergency-stop', this.emergencyStopReason)
        }
    }

    /**
     * 发送成功响应
     */
    private sendSuccessResponse(client: ClientSession, result: FetchResult): void {
        const response = {
            success: true,
            statusCode: result.statusCode,
            headers: result.headers,
            data: result.body.toString('base64')
        }

        this.sendResponse(client, response)
    }

    /**
     * 发送错误响应
     */
    private sendErrorResponse(client: ClientSession, error: string): void {
        const response = {
            success: false,
            error
        }

        this.sendResponse(client, response)
    }

    /**
     * 发送响应
     */
    private sendResponse(client: ClientSession, response: any): void {
        try {
            const data = JSON.stringify(response)
            client.socket.write(data)
        } catch (error) {
            logger.error('发送响应失败', error as Error, { clientId: client.id })
        }
    }

    /**
     * 处理客户端断开连接
     */
    private handleClientDisconnect(client: ClientSession): void {
        this.clients.delete(client.id)

        logger.info('客户端已断开连接', {
            clientId: client.id,
            ip: client.ip,
            totalClients: this.clients.size,
            requestCount: client.requestCount
        })

        this.emit('client-disconnected', client)
    }

    /**
     * 启动服务器
     */
    public async start(): Promise<void> {
        if (this.isRunning) {
            logger.warn('RPC服务器已在运行')
            return
        }

        return new Promise((resolve, reject) => {
            this.server.listen(this.config.server.rpc.port, () => {
                this.isRunning = true

                // 启动动态并发调节
                if (this.dynamicConcurrencyEnabled) {
                    this.startDynamicConcurrencyAdjustment()
                }

                logger.info('RPC服务器已启动', {
                    port: this.config.server.rpc.port,
                    concurrency: this.config.utls.concurrency,
                    dynamicConcurrency: this.dynamicConcurrencyEnabled
                })

                this.emit('started')
                resolve()
            })

            this.server.on('error', reject)
        })
    }

    /**
     * 停止服务器
     */
    public async stop(): Promise<void> {
        if (!this.isRunning) {
            return
        }

        return new Promise((resolve) => {
            // 停止动态并发调节
            if (this.concurrencyAdjustmentInterval) {
                clearInterval(this.concurrencyAdjustmentInterval)
                this.concurrencyAdjustmentInterval = null
            }

            // 关闭所有客户端连接
            for (const client of this.clients.values()) {
                client.socket.destroy()
            }
            this.clients.clear()

            // 关闭服务器
            this.server.close(() => {
                this.isRunning = false
                logger.info('RPC服务器已停止')
                this.emit('stopped')
                resolve()
            })
        })
    }

    /**
     * 启动动态并发调节
     */
    private startDynamicConcurrencyAdjustment(): void {
        this.concurrencyAdjustmentInterval = setInterval(async () => {
            try {
                await this.adjustConcurrencyBasedOnSystemResources()
            } catch (error) {
                logger.error('动态并发调节失败', error as Error)
            }
        }, 30000) // 每30秒检查一次

        logger.info('动态并发调节已启动')
    }

    /**
     * 基于系统资源调整并发
     */
    private async adjustConcurrencyBasedOnSystemResources(): Promise<void> {
        try {
            const systemStats = await this.systemMonitor.getStats()
            const fetcherStats = this.fetcher.getStats()

            const targetConcurrency = this.calculateTargetConcurrency(systemStats, fetcherStats)

            if (targetConcurrency !== this.fetcher.getStats().concurrency) {
                this.fetcher.setConcurrency(targetConcurrency)
                logger.info('并发数已调整', {
                    old: this.fetcher.getStats().concurrency,
                    new: targetConcurrency,
                    reason: 'system-resources'
                })
            }

            this.lastSystemStats = systemStats
        } catch (error) {
            logger.error('系统资源监控失败', error as Error)
        }
    }

    /**
     * 计算目标并发数
     */
    private calculateTargetConcurrency(systemStats: any, fetcherStats: any): number {
        const { cpu, memory } = systemStats
        const { performance } = fetcherStats

        let targetConcurrency = this.config.utls.concurrency

        // 基于CPU使用率调整
        if (cpu.usage > 80) {
            targetConcurrency = Math.max(targetConcurrency * 0.8, 5)
        } else if (cpu.usage < 30 && performance.successRate > 0.9) {
            targetConcurrency = Math.min(targetConcurrency * 1.2, 300)
        }

        // 基于内存使用率调整
        if (memory.usage > 85) {
            targetConcurrency = Math.max(targetConcurrency * 0.9, 5)
        }

        // 基于性能指标调整
        if (performance.avgResponseTime > 2000) {
            targetConcurrency = Math.max(targetConcurrency * 0.9, 5)
        } else if (performance.avgResponseTime < 500 && performance.successRate > 0.95) {
            targetConcurrency = Math.min(targetConcurrency * 1.1, 300)
        }

        return Math.round(targetConcurrency)
    }

    /**
     * 更新配置
     */
    public updateConfig(newConfig: ServerConfig): void {
        this.config = newConfig

        // 更新IPv6池配置
        this.ipv6Pool.updateHealthCheckConfig(newConfig.ipv6.healthCheck)

        // 更新数据获取器配置
        this.fetcher.updateConfig({
            concurrency: newConfig.utls.concurrency,
            enableKeepAlive: newConfig.utls.enableKeepAlive,
            enableAdaptiveConcurrency: newConfig.utls.enableAdaptiveConcurrency,
            dataValidation: newConfig.dataValidation
        })

        logger.info('RPC服务器配置已更新')
    }

    /**
     * 获取统计信息
     */
    public getStats(): ServerStats {
        const fetcherStats = this.fetcher.getStats()
        const ipv6Stats = this.ipv6Pool.getStats()

        return {
            totalClients: this.clients.size,
            fetcherType: 'utls',
            fetcherStats,
            ipv6Stats,
            system: this.lastSystemStats || {
                cpu: { usage: 0, cores: 0, loadAvg: [0, 0, 0] },
                memory: { total: 0, used: 0, free: 0, usage: 0 },
                network: { rx: 0, tx: 0, rxTotal: 0, txTotal: 0 },
                uptime: 0
            },
            health: {
                status: this.emergencyStop ? 500 : 200,
                message: this.emergencyStop ? '紧急停止' : '正常',
                lastCheck: Date.now()
            },
            utlsHealth: {
                status: this.emergencyStop ? 'error' : 'healthy',
                message: this.emergencyStop ? this.emergencyStopReason : '正常',
                lastCheck: Date.now()
            },
            emergencyStop: this.emergencyStop,
            emergencyStopReason: this.emergencyStopReason,
            dynamicConcurrency: {
                enabled: this.dynamicConcurrencyEnabled,
                current: fetcherStats.concurrency,
                adaptive: fetcherStats.adaptiveConcurrency,
                keepAlive: fetcherStats.keepAliveEnabled,
                performance: fetcherStats.performance
            }
        }
    }

    /**
     * 获取所有客户端
     */
    public getClients(): ClientSession[] {
        return Array.from(this.clients.values())
    }

    /**
     * 检查是否运行中
     */
    public isServerRunning(): boolean {
        return this.isRunning
    }

    /**
     * 销毁服务器
     */
    public destroy(): void {
        this.stop().then(() => {
            this.fetcher.destroy()
            logger.info('RPC服务器已销毁')
        })
    }
}
