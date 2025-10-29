/**
 * IPv6 地址池管理
 * 负责IPv6地址的分配、健康检查、统计等功能
 */

import { EventEmitter } from 'events'
import { IPv6Address, IPv6PoolStats, IPv6HealthCheckConfig } from '../../types/index.js'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('IPv6Pool')

export class IPv6Pool extends EventEmitter {
    private addresses: Map<string, IPv6Address> = new Map()
    private currentIndex = 0
    private healthCheckConfig: IPv6HealthCheckConfig
    private stats = {
        totalRequests: 0,
        totalSuccess: 0,
        totalFailure: 0,
        startTime: Date.now()
    }

    constructor(
        private prefix: string,
        private start: number,
        private count: number,
        healthCheckConfig: IPv6HealthCheckConfig
    ) {
        super()
        this.healthCheckConfig = healthCheckConfig
        this.initializeAddresses()
    }

    /**
     * 初始化地址池
     */
    private initializeAddresses(): void {
        if (!this.prefix || this.count === 0) {
            logger.info('IPv6 地址池未启用', { prefix: this.prefix, count: this.count })
            return
        }

        for (let i = 0; i < this.count; i++) {
            const suffix = this.start + i
            const address = `${this.prefix}::${suffix}`

            this.addresses.set(address, {
                address,
                requests: 0,
                success: 0,
                failure: 0,
                avgResponseTime: 0,
                lastUsed: 0,
                isHealthy: true,
                isBlacklisted: false
            })
        }

        logger.info('IPv6 地址池初始化完成', {
            prefix: this.prefix,
            count: this.count,
            range: `${this.start} ~ ${this.start + this.count - 1}`
        })
    }

    /**
     * 获取下一个健康的IPv6地址
     */
    public getHealthyNext(): string | null {
        if (this.addresses.size === 0) {
            return null
        }

        const healthyAddresses = Array.from(this.addresses.values())
            .filter(addr => addr.isHealthy && !addr.isBlacklisted)

        if (healthyAddresses.length === 0) {
            logger.warn('没有可用的健康IPv6地址')
            return null
        }

        // 轮询选择
        const selected = healthyAddresses[this.currentIndex % healthyAddresses.length]
        this.currentIndex++

        // 更新使用时间
        selected.lastUsed = Date.now()

        logger.debug('选择IPv6地址', {
            address: selected.address.substring(0, 30),
            requests: selected.requests
        })

        return selected.address
    }

    /**
     * 记录请求结果
     */
    public recordRequest(address: string, statusCode: number, responseTime: number): void {
        const addr = this.addresses.get(address)
        if (!addr) {
            return
        }

        addr.requests++
        addr.avgResponseTime = this.calculateAverageResponseTime(addr, responseTime)

        // 更新统计
        this.stats.totalRequests++

        if (statusCode === 200) {
            addr.success++
            this.stats.totalSuccess++
        } else {
            addr.failure++
            this.stats.totalFailure++

            // 检查是否需要加入黑名单
            this.checkBlacklist(addr, statusCode)
        }

        // 检查健康状态
        this.checkHealth(addr)

        logger.debug('记录IPv6请求', {
            address: address.substring(0, 30),
            statusCode,
            responseTime,
            requests: addr.requests,
            success: addr.success,
            failure: addr.failure
        })
    }

    /**
     * 计算平均响应时间
     */
    private calculateAverageResponseTime(addr: IPv6Address, newTime: number): number {
        if (addr.requests === 1) {
            return newTime
        }
        return (addr.avgResponseTime * (addr.requests - 1) + newTime) / addr.requests
    }

    /**
     * 检查是否需要加入黑名单
     */
    private checkBlacklist(addr: IPv6Address, statusCode: number): void {
        if (statusCode === 403) {
            // 403错误直接加入黑名单
            addr.isBlacklisted = true
            logger.warn('IPv6地址因403错误被加入黑名单', {
                address: addr.address.substring(0, 30)
            })
        } else if (addr.failure >= this.healthCheckConfig.maxError403Count) {
            // 失败次数过多
            addr.isBlacklisted = true
            logger.warn('IPv6地址因失败次数过多被加入黑名单', {
                address: addr.address.substring(0, 30),
                failures: addr.failure
            })
        }
    }

    /**
     * 检查地址健康状态
     */
    private checkHealth(addr: IPv6Address): void {
        if (addr.requests < this.healthCheckConfig.minRequestsBeforeCheck) {
            return
        }

        const failureRate = addr.failure / addr.requests
        const isSlow = addr.avgResponseTime > this.healthCheckConfig.responseTimeThreshold
        const isHighFailureRate = failureRate > this.healthCheckConfig.failureRateThreshold

        if (isHighFailureRate || isSlow) {
            addr.isHealthy = false
            logger.warn('IPv6地址健康状态异常', {
                address: addr.address.substring(0, 30),
                failureRate: Math.round(failureRate * 100) / 100,
                avgResponseTime: addr.avgResponseTime,
                isSlow,
                isHighFailureRate
            })
        } else {
            addr.isHealthy = true
        }
    }

    /**
     * 获取所有地址
     */
    public getAllAddresses(): string[] {
        return Array.from(this.addresses.keys())
    }

    /**
     * 获取统计信息
     */
    public getStats(): IPv6PoolStats {
        const total = this.addresses.size
        const healthy = Array.from(this.addresses.values()).filter(addr => addr.isHealthy).length
        const blacklisted = Array.from(this.addresses.values()).filter(addr => addr.isBlacklisted).length

        const now = Date.now()
        const uptime = now - this.stats.startTime
        const qps = this.stats.totalRequests / (uptime / 1000)

        const successRate = this.stats.totalRequests > 0
            ? this.stats.totalSuccess / this.stats.totalRequests
            : 0

        const avgResponseTime = this.calculateOverallAvgResponseTime()
        const avgPerIP = total > 0 ? this.stats.totalRequests / total : 0

        // 计算负载均衡度
        const requests = Array.from(this.addresses.values()).map(addr => addr.requests)
        const balance = this.calculateBalance(requests)

        return {
            total,
            healthy,
            blacklisted,
            qps: Math.round(qps * 100) / 100,
            successRate: Math.round(successRate * 100) / 100,
            totalSuccess: this.stats.totalSuccess,
            totalFailure: this.stats.totalFailure,
            avgResponseTime: Math.round(avgResponseTime),
            avgPerIP: Math.round(avgPerIP * 100) / 100,
            balance,
            hasIPv6: total > 0
        }
    }

    /**
     * 获取详细统计信息
     */
    public getDetailedStats(): any {
        const stats = this.getStats()
        const items = Array.from(this.addresses.values())
            .sort((a, b) => b.requests - a.requests)
            .map(addr => ({
                address: addr.address,
                requests: addr.requests,
                success: addr.success,
                failure: addr.failure,
                avgResponseTime: Math.round(addr.avgResponseTime),
                lastUsed: addr.lastUsed,
                isHealthy: addr.isHealthy,
                isBlacklisted: addr.isBlacklisted
            }))

        return {
            ...stats,
            totalAddresses: stats.total,
            averagePerIP: stats.avgPerIP,
            requestsPerSecond: stats.qps.toString(),
            uptime: Math.round((Date.now() - this.stats.startTime) / 1000),
            items
        }
    }

    /**
     * 计算整体平均响应时间
     */
    private calculateOverallAvgResponseTime(): number {
        const addresses = Array.from(this.addresses.values())
        if (addresses.length === 0) {
            return 0
        }

        const totalTime = addresses.reduce((sum, addr) => sum + (addr.avgResponseTime * addr.requests), 0)
        const totalRequests = addresses.reduce((sum, addr) => sum + addr.requests, 0)

        return totalRequests > 0 ? totalTime / totalRequests : 0
    }

    /**
     * 计算负载均衡度
     */
    private calculateBalance(requests: number[]): string {
        if (requests.length === 0) {
            return 'N/A'
        }

        const avg = requests.reduce((sum, req) => sum + req, 0) / requests.length
        const variance = requests.reduce((sum, req) => sum + Math.pow(req - avg, 2), 0) / requests.length
        const stdDev = Math.sqrt(variance)
        const coefficient = avg > 0 ? stdDev / avg : 0

        if (coefficient < 0.2) {
            return '优秀'
        } else if (coefficient < 0.5) {
            return '良好'
        } else if (coefficient < 0.8) {
            return '一般'
        } else {
            return '较差'
        }
    }

    /**
     * 更新健康检查配置
     */
    public updateHealthCheckConfig(config: Partial<IPv6HealthCheckConfig>): void {
        this.healthCheckConfig = { ...this.healthCheckConfig, ...config }
        logger.info('IPv6健康检查配置已更新', this.healthCheckConfig)
    }

    /**
     * 重置地址池
     */
    public reset(): void {
        this.addresses.clear()
        this.currentIndex = 0
        this.stats = {
            totalRequests: 0,
            totalSuccess: 0,
            totalFailure: 0,
            startTime: Date.now()
        }
        this.initializeAddresses()
        logger.info('IPv6地址池已重置')
    }

    /**
     * 清理黑名单
     */
    public clearBlacklist(): void {
        for (const addr of this.addresses.values()) {
            addr.isBlacklisted = false
        }
        logger.info('IPv6地址池黑名单已清理')
    }

    /**
     * 恢复健康状态
     */
    public restoreHealth(): void {
        for (const addr of this.addresses.values()) {
            addr.isHealthy = true
        }
        logger.info('IPv6地址池健康状态已恢复')
    }
}
