/**
 * 系统监控模块
 * 收集CPU、内存、网络等系统信息
 */

import * as os from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'
import { SystemStats } from '../types/index.js'
import { createLogger } from '../utils/logger.js'

const execAsync = promisify(exec)
const logger = createLogger('SystemMonitor')

export class SystemMonitor {
    private lastCpuInfo: { idle: number; total: number } | null = null
    private lastNetworkInfo: { rx: number; tx: number; time: number } | null = null

    /**
     * 获取系统统计信息
     */
    public async getStats(): Promise<SystemStats> {
        const [cpu, memory, network] = await Promise.all([
            this.getCpuStats(),
            this.getMemoryStats(),
            this.getNetworkStats()
        ])

        return {
            cpu,
            memory,
            network,
            uptime: os.uptime()
        }
    }

    /**
     * 获取CPU统计
     */
    private async getCpuStats() {
        const cpus = os.cpus()
        const loadAvg = os.loadavg()

        // 计算CPU使用率
        let idle = 0
        let total = 0

        cpus.forEach(cpu => {
            for (const type in cpu.times) {
                total += cpu.times[type as keyof typeof cpu.times]
            }
            idle += cpu.times.idle
        })

        let usage = 0
        if (this.lastCpuInfo) {
            const idleDiff = idle - this.lastCpuInfo.idle
            const totalDiff = total - this.lastCpuInfo.total
            usage = 100 - Math.floor((idleDiff / totalDiff) * 100)
        }

        this.lastCpuInfo = { idle, total }

        return {
            usage: Math.max(0, Math.min(100, usage)),
            cores: cpus.length,
            loadAvg: loadAvg.map(v => Math.round(v * 100) / 100)
        }
    }

    /**
     * 获取内存统计
     */
    private async getMemoryStats() {
        const totalMem = os.totalmem()
        const freeMem = os.freemem()
        const usedMem = totalMem - freeMem

        return {
            total: Math.round(totalMem / 1024 / 1024),
            used: Math.round(usedMem / 1024 / 1024),
            free: Math.round(freeMem / 1024 / 1024),
            usage: Math.round((usedMem / totalMem) * 100)
        }
    }

    /**
     * 获取网络统计
     */
    private async getNetworkStats() {
        try {
            // Linux 系统读取 /proc/net/dev
            const { stdout } = await execAsync('cat /proc/net/dev')
            const lines = stdout.split('\n')

            let rxTotal = 0
            let txTotal = 0

            // 解析网络接口数据，跳过lo（本地回环）
            for (const line of lines) {
                if (line.includes(':') && !line.includes('lo:')) {
                    const parts = line.trim().split(/\s+/)
                    if (parts.length >= 10) {
                        rxTotal += parseInt(parts[1]) || 0
                        txTotal += parseInt(parts[9]) || 0
                    }
                }
            }

            const now = Date.now()
            let rx = 0
            let tx = 0

            if (this.lastNetworkInfo) {
                const timeDiff = (now - this.lastNetworkInfo.time) / 1000 // 秒
                rx = Math.round((rxTotal - this.lastNetworkInfo.rx) / timeDiff)
                tx = Math.round((txTotal - this.lastNetworkInfo.tx) / timeDiff)
            }

            this.lastNetworkInfo = { rx: rxTotal, tx: txTotal, time: now }

            return {
                rx: Math.max(0, rx),
                tx: Math.max(0, tx),
                rxTotal,
                txTotal
            }
        } catch (error) {
            // 如果读取失败，返回0
            logger.warn('获取网络统计失败', { error: (error as Error).message })
            return {
                rx: 0,
                tx: 0,
                rxTotal: 0,
                txTotal: 0
            }
        }
    }

    /**
     * 获取系统健康评分
     */
    public async getHealthScore(): Promise<number> {
        try {
            const stats = await this.getStats()
            const { cpu, memory, network } = stats

            // CPU 健康评分（使用率越低越好）
            const cpuScore = Math.max(0, 100 - cpu.usage)

            // 内存健康评分（使用率越低越好）
            const memoryScore = Math.max(0, 100 - memory.usage)

            // 负载健康评分（负载越低越好）
            const loadScore = Math.max(0, 100 - (cpu.loadAvg[0] * 25))

            // 网络健康评分（基于是否有流量）
            const networkScore = (network.rx > 0 || network.tx > 0) ? 100 : 50

            return Math.round((cpuScore + memoryScore + loadScore + networkScore) / 4)
        } catch (error) {
            logger.error('获取系统健康评分失败', error as Error)
            return 0
        }
    }

    /**
     * 检查系统是否过载
     */
    public async isOverloaded(thresholds: {
        cpuUsage?: number
        memoryUsage?: number
        loadAvg?: number
    } = {}): Promise<boolean> {
        try {
            const stats = await this.getStats()
            const {
                cpuUsage = 80,
                memoryUsage = 85,
                loadAvg = 2
            } = thresholds

            return (
                stats.cpu.usage > cpuUsage ||
                stats.memory.usage > memoryUsage ||
                stats.cpu.loadAvg[0] > loadAvg
            )
        } catch (error) {
            logger.error('检查系统过载状态失败', error as Error)
            return false
        }
    }

    /**
     * 获取系统资源使用趋势
     */
    public async getResourceTrends(samples: number = 10): Promise<{
        cpu: number[]
        memory: number[]
        load: number[]
    }> {
        // 这里可以实现历史数据收集
        // 目前返回当前值作为示例
        const stats = await this.getStats()

        return {
            cpu: new Array(samples).fill(stats.cpu.usage),
            memory: new Array(samples).fill(stats.memory.usage),
            load: new Array(samples).fill(stats.cpu.loadAvg[0])
        }
    }
}
