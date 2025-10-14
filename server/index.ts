/**
 * ZeroMaps RPC 服务器启动文件
 */

import { RpcServer } from './rpc-server.js'
import { StatsExporter } from './stats-exporter.js'
import { MonitorServer } from './monitor-server.js'
import { WebhookServer } from './webhook-server.js'

// 全局错误处理，防止未捕获的异常导致进程崩溃
process.on('uncaughtException', (error) => {
  console.error('❌ 未捕获的异常:', error)
  console.error('堆栈:', error.stack)
  // 不退出进程，继续运行
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未处理的 Promise 拒绝:', reason)
  console.error('Promise:', promise)
  // 不退出进程，继续运行
})

// 配置
const PORT = 9527
const MONITOR_PORT = 9528
const WEBHOOK_PORT = 9530

// IPv6 前缀（可选，如果未设置则不使用 IPv6）
const IPV6_PREFIX: string = process.env.IPV6_PREFIX || ''

if (!IPV6_PREFIX) {
  console.warn('⚠️  未设置 IPV6_PREFIX 环境变量')
  console.warn('   将使用默认网络（不绑定 IPv6 地址）')
  console.warn('   如需使用 IPv6，请在 ecosystem.config.cjs 中配置 IPV6_PREFIX')
}

// 创建并启动服务器
async function main() {
  console.log('='.repeat(50))
  console.log('ZeroMaps RPC 服务器')
  console.log('='.repeat(50))

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
      console.log('\n' + '='.repeat(50))
      console.log('📊 服务器统计')
      console.log('='.repeat(50))
      console.log(`👥 在线客户端: ${stats.totalClients}`)
      console.log(`📦 总请求数: ${stats.fetcherStats.totalRequests}`)
      console.log(`⚡ 当前并发: ${stats.fetcherStats.concurrentRequests}`)
      console.log(`📈 最大并发: ${stats.fetcherStats.maxConcurrent}`)

      if (stats.system) {
        console.log(`\n💻 系统资源:`)
        console.log(`  ├─ CPU: ${stats.system.cpu.usage}% (${stats.system.cpu.cores} 核心)`)
        console.log(`  ├─ 内存: ${stats.system.memory.used}MB / ${stats.system.memory.total}MB (${stats.system.memory.usage}%)`)
        console.log(`  └─ 网络: ↓${formatBytes(stats.system.network.rx)}/s ↑${formatBytes(stats.system.network.tx)}/s`)
      }

      if (stats.ipv6Stats) {
        console.log(`\n🌐 IPv6 池统计:`)
        console.log(`  ├─ 总地址数: ${stats.ipv6Stats.totalAddresses}`)
        console.log(`  ├─ 总请求数: ${stats.ipv6Stats.totalRequests}`)
        console.log(`  ├─ 成功请求: ${stats.ipv6Stats.totalSuccess} (${stats.ipv6Stats.successRate}%)`)
        console.log(`  ├─ 失败请求: ${stats.ipv6Stats.totalFailure}`)
        console.log(`  ├─ 平均每IP: ${stats.ipv6Stats.averagePerIP} 次`)
        console.log(`  ├─ 平衡度: ${stats.ipv6Stats.balance} (差值)`)
        console.log(`  ├─ 平均响应时间: ${stats.ipv6Stats.avgResponseTime}ms`)
        console.log(`  ├─ 运行时间: ${formatUptime(stats.ipv6Stats.uptime)}`)
        console.log(`  └─ 请求速率: ${stats.ipv6Stats.requestsPerSecond} req/s`)
      }
      console.log('='.repeat(50) + '\n')
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
      console.log('\n📤 收到导出信号，正在导出统计数据...')

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
        console.error('❌ 导出失败:', (error as Error).message)
      }
    })

    // 显示详细统计（发送 SIGUSR2 信号触发）
    // 使用方法: kill -SIGUSR2 <进程ID>
    process.on('SIGUSR2', () => {
      console.log('\n📊 收到详细统计信号...')

      try {
        const ipv6Pool = server.getIPv6Pool()
        StatsExporter.showDetailedStats(ipv6Pool)
      } catch (error) {
        console.error('❌ 显示失败:', (error as Error).message)
      }
    })

    // 优雅退出
    process.on('SIGINT', async () => {
      console.log('\n收到退出信号，正在关闭服务器...')
      await server.stop()
      process.exit(0)
    })

    process.on('SIGTERM', async () => {
      console.log('\n收到退出信号，正在关闭服务器...')
      await server.stop()
      process.exit(0)
    })

  } catch (error) {
    console.error('服务器启动失败:', error)
    process.exit(1)
  }
}

main()

