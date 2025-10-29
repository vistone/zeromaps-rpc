/**
 * 指标工具类
 * 用于收集、计算和管理各种性能指标
 */

import { PerformanceMetrics } from '../types/index.js'

export class MetricsCollector {
    private metrics: Map<string, number[]> = new Map()
    private counters: Map<string, number> = new Map()
    private timers: Map<string, number> = new Map()

    /**
     * 记录数值指标
     */
    public recordValue(key: string, value: number): void {
        if (!this.metrics.has(key)) {
            this.metrics.set(key, [])
        }
        this.metrics.get(key)!.push(value)
    }

    /**
     * 增加计数器
     */
    public incrementCounter(key: string, value: number = 1): void {
        const current = this.counters.get(key) || 0
        this.counters.set(key, current + value)
    }

    /**
     * 开始计时
     */
    public startTimer(key: string): void {
        this.timers.set(key, Date.now())
    }

    /**
     * 结束计时并记录
     */
    public endTimer(key: string): number {
        const startTime = this.timers.get(key)
        if (!startTime) {
            return 0
        }

        const duration = Date.now() - startTime
        this.recordValue(key, duration)
        this.timers.delete(key)
        return duration
    }

    /**
     * 获取平均值
     */
    public getAverage(key: string): number {
        const values = this.metrics.get(key)
        if (!values || values.length === 0) {
            return 0
        }
        return values.reduce((sum, val) => sum + val, 0) / values.length
    }

    /**
     * 获取最大值
     */
    public getMax(key: string): number {
        const values = this.metrics.get(key)
        if (!values || values.length === 0) {
            return 0
        }
        return Math.max(...values)
    }

    /**
     * 获取最小值
     */
    public getMin(key: string): number {
        const values = this.metrics.get(key)
        if (!values || values.length === 0) {
            return 0
        }
        return Math.min(...values)
    }

    /**
     * 获取计数器的值
     */
    public getCounter(key: string): number {
        return this.counters.get(key) || 0
    }

    /**
     * 获取所有指标
     */
    public getAllMetrics(): Record<string, any> {
        const result: Record<string, any> = {}

        // 数值指标
        for (const [key, values] of this.metrics) {
            if (values.length > 0) {
                result[key] = {
                    count: values.length,
                    average: this.getAverage(key),
                    min: this.getMin(key),
                    max: this.getMax(key),
                    latest: values[values.length - 1]
                }
            }
        }

        // 计数器
        for (const [key, value] of this.counters) {
            result[key] = value
        }

        return result
    }

    /**
     * 清理旧数据（保留最近N个值）
     */
    public cleanup(keepCount: number = 100): void {
        for (const [key, values] of this.metrics) {
            if (values.length > keepCount) {
                this.metrics.set(key, values.slice(-keepCount))
            }
        }
    }

    /**
     * 重置所有指标
     */
    public reset(): void {
        this.metrics.clear()
        this.counters.clear()
        this.timers.clear()
    }
}

/**
 * 性能指标计算器
 */
export class PerformanceCalculator {
    private responseTimes: number[] = []
    private successCount = 0
    private failureCount = 0
    private lastAdjustment = Date.now()
    private adjustmentCount = 0

    /**
     * 记录请求结果
     */
    public recordRequest(responseTime: number, success: boolean): void {
        this.responseTimes.push(responseTime)

        if (success) {
            this.successCount++
        } else {
            this.failureCount++
        }

        // 保持最近1000个响应时间
        if (this.responseTimes.length > 1000) {
            this.responseTimes = this.responseTimes.slice(-1000)
        }
    }

    /**
     * 获取平均响应时间
     */
    public getAverageResponseTime(): number {
        if (this.responseTimes.length === 0) {
            return 0
        }
        return this.responseTimes.reduce((sum, time) => sum + time, 0) / this.responseTimes.length
    }

    /**
     * 获取成功率
     */
    public getSuccessRate(): number {
        const total = this.successCount + this.failureCount
        if (total === 0) {
            return 1.0
        }
        return this.successCount / total
    }

    /**
     * 获取总请求数
     */
    public getTotalRequests(): number {
        return this.successCount + this.failureCount
    }

    /**
     * 记录并发调整
     */
    public recordAdjustment(): void {
        this.adjustmentCount++
        this.lastAdjustment = Date.now()
    }

    /**
     * 获取性能指标
     */
    public getMetrics(): PerformanceMetrics {
        return {
            avgResponseTime: this.getAverageResponseTime(),
            successRate: this.getSuccessRate(),
            adjustmentCount: this.adjustmentCount,
            lastAdjustment: this.lastAdjustment
        }
    }

    /**
     * 重置指标
     */
    public reset(): void {
        this.responseTimes = []
        this.successCount = 0
        this.failureCount = 0
        this.lastAdjustment = Date.now()
        this.adjustmentCount = 0
    }
}

/**
 * 系统资源监控器
 */
export class SystemResourceMonitor {
    private cpuHistory: number[] = []
    private memoryHistory: number[] = []
    private loadHistory: number[] = []

    /**
     * 记录系统资源使用情况
     */
    public recordResources(cpuUsage: number, memoryUsage: number, loadAvg: number): void {
        this.cpuHistory.push(cpuUsage)
        this.memoryHistory.push(memoryUsage)
        this.loadHistory.push(loadAvg)

        // 保持最近100个记录
        if (this.cpuHistory.length > 100) {
            this.cpuHistory = this.cpuHistory.slice(-100)
            this.memoryHistory = this.memoryHistory.slice(-100)
            this.loadHistory = this.loadHistory.slice(-100)
        }
    }

    /**
     * 获取平均CPU使用率
     */
    public getAverageCpuUsage(): number {
        if (this.cpuHistory.length === 0) {
            return 0
        }
        return this.cpuHistory.reduce((sum, usage) => sum + usage, 0) / this.cpuHistory.length
    }

    /**
     * 获取平均内存使用率
     */
    public getAverageMemoryUsage(): number {
        if (this.memoryHistory.length === 0) {
            return 0
        }
        return this.memoryHistory.reduce((sum, usage) => sum + usage, 0) / this.memoryHistory.length
    }

    /**
     * 获取平均负载
     */
    public getAverageLoad(): number {
        if (this.loadHistory.length === 0) {
            return 0
        }
        return this.loadHistory.reduce((sum, load) => sum + load, 0) / this.loadHistory.length
    }

    /**
     * 检查系统是否过载
     */
    public isOverloaded(cpuThreshold: number = 80, memoryThreshold: number = 85, loadThreshold: number = 2): boolean {
        const avgCpu = this.getAverageCpuUsage()
        const avgMemory = this.getAverageMemoryUsage()
        const avgLoad = this.getAverageLoad()

        return avgCpu > cpuThreshold || avgMemory > memoryThreshold || avgLoad > loadThreshold
    }

    /**
     * 获取系统健康评分（0-100）
     */
    public getHealthScore(): number {
        const avgCpu = this.getAverageCpuUsage()
        const avgMemory = this.getAverageMemoryUsage()
        const avgLoad = this.getAverageLoad()

        // 计算健康评分（越低越好）
        const cpuScore = Math.max(0, 100 - avgCpu)
        const memoryScore = Math.max(0, 100 - avgMemory)
        const loadScore = Math.max(0, 100 - (avgLoad * 25)) // 负载4.0 = 0分

        return Math.round((cpuScore + memoryScore + loadScore) / 3)
    }
}
