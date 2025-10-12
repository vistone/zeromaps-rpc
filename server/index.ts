/**
 * ZeroMaps RPC 服务器启动文件
 */

import { RpcServer } from './rpc-server.js'
import { StatsExporter } from './stats-exporter.js'
import { MonitorServer } from './monitor-server.js'

// 配置
const PORT = 9527
const MONITOR_PORT = 9528  // Web监控端口
const IPV6_PREFIX = process.env.IPV6_PREFIX || '2607:8700:5500:2043' // 从环境变量读取或使用默认值
const CURL_PATH = '/usr/local/bin/curl-impersonate-chrome' // 直接使用底层二进制，避免脚本覆盖 headers

// 创建并启动服务器
async function main() {
  console.log('='.repeat(50))
  console.log('ZeroMaps RPC 服务器')
  console.log('='.repeat(50))

  const server = new RpcServer(PORT, IPV6_PREFIX, CURL_PATH)

  try {
    await server.start()

    // 启动Web监控服务器
    const monitorServer = new MonitorServer(MONITOR_PORT, server)
    monitorServer.start()

    // 定期打印统计信息
    setInterval(() => {
      const stats = server.getStats()
      console.log('\n' + '='.repeat(50))
      console.log('📊 服务器统计')
      console.log('='.repeat(50))
      console.log(`👥 在线客户端: ${stats.totalClients}`)
      console.log(`📦 总请求数: ${stats.curlStats.totalRequests}`)
      console.log(`⚡ 当前并发: ${stats.curlStats.concurrentRequests}`)
      console.log(`📈 最大并发: ${stats.curlStats.maxConcurrent}`)

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

