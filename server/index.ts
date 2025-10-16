/**
 * ZeroMaps RPC 服务器启动文件
 */

import { RpcServer } from './rpc-server.js'
import { StatsExporter } from './stats-exporter.js'
import { MonitorServer } from './monitor-server.js'
import { WebhookServer } from './webhook-server.js'
import { createLogger } from './logger.js'

const logger = createLogger('MainProcess')

// 全局错误处理，防止未捕获的异常导致进程崩溃
process.on('uncaughtException', (error) => {
  logger.error('未捕获的异常', error)
  // 不退出进程，继续运行
})

process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的 Promise 拒绝', reason as Error, { promise })
  // 不退出进程，继续运行
})

// 配置
const PORT = 9527
const MONITOR_PORT = 9528
const WEBHOOK_PORT = 9530

// IPv6 前缀（可选，如果未设置则不使用 IPv6）
const IPV6_PREFIX: string = process.env.IPV6_PREFIX || ''

if (!IPV6_PREFIX) {
  logger.warn('未设置 IPV6_PREFIX 环境变量，将使用默认网络')
}

// 创建并启动服务器
async function main() {
  logger.info('ZeroMaps RPC 服务器启动中...')

  const server = new RpcServer(PORT, IPV6_PREFIX)

  try {
    await server.start()

    // 启动Web监控服务器（包含 HTTP API 和 WebSocket）
    const monitorServer = new MonitorServer(MONITOR_PORT, server)
    monitorServer.start()

    // 启动 GitHub Webhook 服务器（用于自动更新）
    const webhookServer = new WebhookServer(WEBHOOK_PORT)
    webhookServer.start()

    // 定期打印统计信息
    setInterval(async () => {
      const stats = await server.getStats()
      logger.info('服务器统计', {
        clients: stats.totalClients,
        totalRequests: stats.fetcherStats.totalRequests,
        concurrent: stats.fetcherStats.concurrentRequests,
        maxConcurrent: stats.fetcherStats.maxConcurrent,
        system: stats.system ? {
          cpu: `${stats.system.cpu.usage}%`,
          memory: `${stats.system.memory.used}MB / ${stats.system.memory.total}MB (${stats.system.memory.usage}%)`,
          network: `↓${formatBytes(stats.system.network.rx)}/s ↑${formatBytes(stats.system.network.tx)}/s`
        } : null,
        ipv6: stats.ipv6Stats ? {
          totalAddresses: stats.ipv6Stats.totalAddresses,
          totalRequests: stats.ipv6Stats.totalRequests,
          successRate: `${stats.ipv6Stats.successRate}%`,
          avgResponseTime: `${stats.ipv6Stats.avgResponseTime}ms`,
          qps: `${stats.ipv6Stats.requestsPerSecond} req/s`
        } : null
      })
    }, 60000) // 每分钟打印一次

    // 格式化字节数
    function formatBytes(bytes: number): string {
      if (bytes === 0) return '0 B'
      const k = 1024
      const sizes = ['B', 'KB', 'MB', 'GB']
      const i = Math.floor(Math.log(bytes) / Math.log(k))
      return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
    }

    // 格式化运行时间
    function formatUptime(seconds: number): string {
      const days = Math.floor(seconds / 86400)
      const hours = Math.floor((seconds % 86400) / 3600)
      const mins = Math.floor((seconds % 3600) / 60)
      const secs = seconds % 60

      if (days > 0) return `${days}天${hours}小时${mins}分钟`
      if (hours > 0) return `${hours}小时${mins}分钟${secs}秒`
      if (mins > 0) return `${mins}分钟${secs}秒`
      return `${secs}秒`
    }

    // 定期导出统计数据到临时文件（用于外部监控工具）
    setInterval(() => {
      const ipv6Pool = server.getIPv6Pool()
      StatsExporter.exportToTemp(ipv6Pool)
    }, 10000) // 每10秒更新一次

    // 手动导出命令（发送 SIGUSR1 信号触发）
    // 使用方法: kill -SIGUSR1 <进程ID>
    process.on('SIGUSR1', () => {
      logger.info('收到导出信号，正在导出统计数据...')

      try {
        const ipv6Pool = server.getIPv6Pool()

        // 导出JSON和CSV文件
        StatsExporter.exportJSON(ipv6Pool)
        StatsExporter.exportCSV(ipv6Pool)

        // 显示摘要
        StatsExporter.showSummary(ipv6Pool)

        // 显示Top 20
        StatsExporter.showTopIPs(ipv6Pool, 20)
      } catch (error) {
        logger.error('导出失败', error as Error)
      }
    })

    // 显示详细统计（发送 SIGUSR2 信号触发）
    // 使用方法: kill -SIGUSR2 <进程ID>
    process.on('SIGUSR2', () => {
      logger.info('收到详细统计信号')

      try {
        const ipv6Pool = server.getIPv6Pool()
        StatsExporter.showDetailedStats(ipv6Pool)
      } catch (error) {
        logger.error('显示失败', error as Error)
      }
    })

    // 优雅退出
    process.on('SIGINT', async () => {
      logger.info('收到退出信号，正在关闭服务器...')
      await server.stop()
      process.exit(0)
    })

    process.on('SIGTERM', async () => {
      logger.info('收到退出信号，正在关闭服务器...')
      await server.stop()
      process.exit(0)
    })

  } catch (error) {
    logger.error('服务器启动失败', error as Error)
    process.exit(1)
  }
}

main()

