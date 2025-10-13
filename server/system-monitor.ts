/**
 * 系统监控模块
 * 收集CPU、内存、网络等系统信息
 */

import * as os from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export interface SystemStats {
    cpu: {
        usage: number // CPU使用率 (%)
        cores: number // CPU核心数
        loadAvg: number[] // 1, 5, 15分钟平均负载
    }
    memory: {
        total: number // 总内存 (MB)
        used: number // 已用内存 (MB)
        free: number // 空闲内存 (MB)
        usage: number // 使用率 (%)
    }
    network: {
        rx: number // 接收字节数/秒
        tx: number // 发送字节数/秒
        rxTotal: number // 总接收字节数
        txTotal: number // 总发送字节数
    }
    uptime: number // 系统运行时间 (秒)
}

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
            return {
                rx: 0,
                tx: 0,
                rxTotal: 0,
                txTotal: 0
            }
        }
    }
}

